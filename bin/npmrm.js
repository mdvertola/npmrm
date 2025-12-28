#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import cliProgress from "cli-progress";

const program = new Command();

// Concurrency limits - tuned for filesystem I/O
const DIR_CONCURRENCY = 128;   // parallel directory reads
const STAT_CONCURRENCY = 256;  // parallel stat calls
const DELETE_CONCURRENCY = 4;  // parallel deletions (low to avoid OOM on large dirs)

program
  .name("npmrm")
  .description("Recursively find node_modules directories, report sizes, and optionally remove them.")
  .requiredOption("-p, --path <path>", "Root path to scan")
  .option("--follow-symlinks", "Follow symlinks (default: off)", false)
  .option("--max-depth <n>", "Maximum traversal depth (default: unlimited)", (v) => Number(v))
  .option("--json", "Output results as JSON (still prompts unless --yes)", false)
  .option("-y, --yes", "Skip prompt and delete immediately", false)
  .parse(process.argv);

const opts = program.opts();

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${sizes[i]}`;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parallel task executor with concurrency limit
 * Processes tasks as fast as possible while respecting the limit
 */
async function runParallel(tasks, concurrency) {
  const results = new Array(tasks.length);
  let index = 0;
  
  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await tasks[currentIndex]();
      } catch (e) {
        results[currentIndex] = { error: e };
      }
    }
  }
  
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  
  await Promise.all(workers);
  return results;
}

/**
 * OPTIMIZED: Calculate directory size with massive parallelism
 * Uses breadth-first traversal with batched stat calls
 */
async function getDirSizeBytes(dirPath, { followSymlinks }) {
  let total = 0;
  let pending = [dirPath];
  
  while (pending.length > 0) {
    // Read all pending directories in parallel
    const dirTasks = pending.map(dir => async () => {
      try {
        return { dir, entries: await fs.readdir(dir, { withFileTypes: true }) };
      } catch {
        return { dir, entries: [] };
      }
    });
    
    const dirResults = await runParallel(dirTasks, DIR_CONCURRENCY);
    
    const nextDirs = [];
    const statTasks = [];
    
    for (const { dir, entries } of dirResults) {
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        
        if (ent.isSymbolicLink()) {
          if (!followSymlinks) continue;
          statTasks.push(async () => {
            try {
              const st = await fs.stat(full);
              return { isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, full };
            } catch {
              return null;
            }
          });
        } else if (ent.isDirectory()) {
          nextDirs.push(full);
        } else if (ent.isFile()) {
          // Batch stat for file size
          statTasks.push(async () => {
            try {
              const st = await fs.lstat(full);
              return { isDir: false, isFile: true, size: st.size, full };
            } catch {
              return null;
            }
          });
        }
      }
    }
    
    // Execute all stat calls in parallel
    if (statTasks.length > 0) {
      const statResults = await runParallel(statTasks, STAT_CONCURRENCY);
      for (const result of statResults) {
        if (!result) continue;
        if (result.isFile) total += result.size;
        if (result.isDir) nextDirs.push(result.full);
      }
    }
    
    pending = nextDirs;
  }
  
  return total;
}

function shouldSkipDirName(name) {
  return name === ".git" || name === ".cache";
}

/**
 * OPTIMIZED: Find node_modules with parallel directory scanning
 * Uses breadth-first traversal processing entire levels in parallel
 * @param {Function} onProgress - Called after each level with { dirsScanned, nodeModulesFound }
 */
async function findNodeModules(rootPath, { followSymlinks, maxDepth, onProgress }) {
  const results = [];
  const rootAbs = path.resolve(rootPath);
  const seenRealPaths = followSymlinks ? new Set() : null;
  let dirsScanned = 0;
  
  let currentLevel = [{ dir: rootAbs, depth: 0 }];
  
  while (currentLevel.length > 0) {
    // Process ALL directories at current level in parallel
    const tasks = currentLevel.map(({ dir, depth }) => async () => {
      if (Number.isFinite(maxDepth) && depth > maxDepth) {
        return { nodeModules: [], subdirs: [] };
      }
      
      // Prevent symlink cycles
      if (seenRealPaths) {
        try {
          const real = await fs.realpath(dir);
          if (seenRealPaths.has(real)) return { nodeModules: [], subdirs: [] };
          seenRealPaths.add(real);
        } catch {
          return { nodeModules: [], subdirs: [] };
        }
      }
      
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return { nodeModules: [], subdirs: [] };
      }
      
      const nodeModules = [];
      const subdirs = [];
      const symlinkChecks = [];
      
      for (const ent of entries) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        
        const full = path.join(dir, ent.name);
        
        if (ent.name === "node_modules") {
          nodeModules.push(full);
          continue; // Don't traverse inside
        }
        
        if (shouldSkipDirName(ent.name)) continue;
        
        if (ent.isDirectory()) {
          subdirs.push({ dir: full, depth: depth + 1 });
        } else if (ent.isSymbolicLink() && followSymlinks) {
          symlinkChecks.push({ full, depth: depth + 1 });
        }
      }
      
      // Check symlinks in parallel
      if (symlinkChecks.length > 0) {
        const checkResults = await Promise.all(
          symlinkChecks.map(async ({ full, depth }) => {
            try {
              const st = await fs.stat(full);
              if (st.isDirectory()) return { dir: full, depth };
            } catch {}
            return null;
          })
        );
        for (const r of checkResults) {
          if (r) subdirs.push(r);
        }
      }
      
      return { nodeModules, subdirs };
    });
    
    const batchResults = await runParallel(tasks, DIR_CONCURRENCY);
    
    dirsScanned += currentLevel.length;
    
    const nextLevel = [];
    for (const result of batchResults) {
      if (result.error) continue;
      results.push(...result.nodeModules);
      nextLevel.push(...result.subdirs);
    }
    
    // Report progress after each level
    if (onProgress) {
      onProgress({ dirsScanned, nodeModulesFound: results.length });
    }
    
    currentLevel = nextLevel;
  }
  
  return results;
}

async function removeDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

(async () => {
  const root = opts.path;
  if (!(await pathExists(root))) {
    console.error(chalk.red(`Path does not exist: ${root}`));
    process.exit(1);
  }

  const isInteractive = !opts.json;
  
  // Scanning phase with spinner
  let spinner;
  if (isInteractive) {
    spinner = ora({
      text: chalk.cyan(`Scanning for node_modules under: ${path.resolve(root)}`),
      spinner: 'dots'
    }).start();
  } else {
    console.log(chalk.cyan(`Scanning for node_modules under:`), path.resolve(root));
  }

  const found = await findNodeModules(root, {
    followSymlinks: !!opts.followSymlinks,
    maxDepth: opts.maxDepth,
    onProgress: isInteractive ? ({ dirsScanned, nodeModulesFound }) => {
      spinner.text = chalk.cyan(`Scanning... `) + 
        chalk.white(`${dirsScanned.toLocaleString()} dirs`) + 
        chalk.gray(` | `) + 
        chalk.green(`${nodeModulesFound} node_modules found`);
    } : undefined
  });
  
  if (spinner) {
    spinner.succeed(chalk.green(`Scan complete: ${found.length} node_modules found`));
  }

  if (found.length === 0) {
    console.log(chalk.green("No node_modules directories found."));
    process.exit(0);
  }

  // OPTIMIZED: Calculate ALL sizes in parallel with progress bar
  let sizeProgress;
  let sizeCompleted = 0;
  
  if (isInteractive) {
    sizeProgress = new cliProgress.SingleBar({
      format: chalk.cyan('Calculating sizes ') + chalk.white('[{bar}]') + chalk.gray(' {value}/{total}'),
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true
    });
    sizeProgress.start(found.length, 0);
  }
  
  const sizeTasks = found.map(nmPath => async () => {
    const size = await getDirSizeBytes(nmPath, { followSymlinks: !!opts.followSymlinks });
    if (sizeProgress) {
      sizeProgress.update(++sizeCompleted);
    }
    return { nmPath, size };
  });
  
  const rows = await runParallel(sizeTasks, DIR_CONCURRENCY);
  
  if (sizeProgress) {
    sizeProgress.stop();
  }
  
  const totalBytes = rows.reduce((sum, r) => sum + (r.size || 0), 0);

  // sort by size desc
  rows.sort((a, b) => (b.size || 0) - (a.size || 0));

  if (opts.json) {
    const payload = {
      root: path.resolve(root),
      count: rows.length,
      totalBytes,
      totalHuman: formatBytes(totalBytes),
      nodeModules: rows.map(r => ({ path: r.nmPath, bytes: r.size, human: formatBytes(r.size) }))
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const table = new Table({
      head: [chalk.bold("node_modules path"), chalk.bold("size")],
      colWidths: [Math.min(120, Math.max(40, process.stdout.columns ? process.stdout.columns - 20 : 80)), 14],
      wordWrap: true
    });

    for (const r of rows) {
      table.push([r.nmPath, formatBytes(r.size)]);
    }

    console.log(table.toString());
    console.log(chalk.yellow(`Found: ${rows.length} node_modules`));
    console.log(chalk.yellow(`Total: ${formatBytes(totalBytes)}`));
  }

  if (!opts.yes) {
    const rl = readline.createInterface({ input, output });
    const answer = (await rl.question(chalk.red("Remove ALL listed node_modules? (y/n): "))).trim().toLowerCase();
    rl.close();

    if (answer !== "y" && answer !== "yes") {
      console.log(chalk.gray("Aborted. Nothing removed."));
      process.exit(0);
    }
  }

  // OPTIMIZED: Delete in parallel with controlled concurrency and progress bar
  let deleteProgress;
  let deleteCompleted = 0;
  const deleteErrors = [];
  
  if (isInteractive) {
    deleteProgress = new cliProgress.SingleBar({
      format: chalk.red('Deleting ') + chalk.white('[{bar}]') + chalk.gray(' {value}/{total} ') + chalk.yellow('{currentPath}'),
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true
    });
    deleteProgress.start(rows.length, 0, { currentPath: '' });
  } else {
    console.log(chalk.red("Deleting..."));
  }
  
  const deleteTasks = rows.map(r => async () => {
    try {
      if (deleteProgress) {
        deleteProgress.update(deleteCompleted, { currentPath: path.basename(path.dirname(r.nmPath)) });
      }
      await removeDir(r.nmPath);
      if (deleteProgress) {
        deleteProgress.update(++deleteCompleted);
      }
      return { success: true, path: r.nmPath };
    } catch (e) {
      deleteErrors.push({ path: r.nmPath, error: e?.message ?? e });
      if (deleteProgress) {
        deleteProgress.update(++deleteCompleted);
      }
      return { success: false, path: r.nmPath };
    }
  });
  
  const deleteResults = await runParallel(deleteTasks, DELETE_CONCURRENCY);
  
  if (deleteProgress) {
    deleteProgress.stop();
  }
  
  let removed = 0;
  let failed = 0;
  for (const result of deleteResults) {
    if (result.success) removed++;
    else failed++;
  }
  
  // Print any errors that occurred
  for (const err of deleteErrors) {
    console.error(chalk.red(`Failed to remove: ${err.path}`), err.error);
  }

  console.log(chalk.green(`Done. Removed: ${removed}`) + (failed > 0 ? chalk.red(`, Failed: ${failed}`) : ''));
})();
