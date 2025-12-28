# rmvnm

A blazing-fast CLI tool to **find, analyze, and purge `node_modules` directories** across your filesystem.

Reclaim gigabytes of disk space from old projects, monorepos, and forgotten dev folders — with full visibility before deletion.

---

## Installation

```bash
npm install -g rmvnm
```

Or run directly with npx:

```bash
npx rmvnm -p .
```

---

## Features

- 🚀 **Parallel scanning** — processes directories concurrently for maximum speed
- 📏 **Size analysis** — calculates and displays size of each `node_modules`
- 📊 **Clean table output** — sorted by size with totals
- 📈 **Progress indicators** — real-time spinners and progress bars
- ❓ **Safe by default** — prompts for confirmation before any deletion
- 🔒 **Symlink-safe** — does not follow symlinks unless explicitly enabled
- 🧠 **Smart traversal** — skips `.git`, `.cache`, and inside `node_modules`

---

## Usage

```bash
rmvnm -p <path>
```

### Examples

Scan current directory:

```bash
rmvnm -p .
```

Scan a specific path:

```bash
rmvnm -p ~/projects
```

Skip confirmation prompt:

```bash
rmvnm -p . -y
```

Limit traversal depth:

```bash
rmvnm -p . --max-depth 3
```

Output results as JSON:

```bash
rmvnm -p . --json
```

---

## Output

```
✔ Scan complete: 4 node_modules found
Calculating sizes [████████████████████████████████████████] 4/4
┌──────────────────────────────────────────────────────────────┬───────────────┐
│ node_modules path                                            │ size          │
├──────────────────────────────────────────────────────────────┼───────────────┤
│ /projects/webapp/node_modules                                │ 612 MB        │
│ /projects/api/node_modules                                   │ 287 MB        │
│ /projects/shared/node_modules                                │ 98 MB         │
│ /projects/scripts/node_modules                               │ 24 MB         │
└──────────────────────────────────────────────────────────────┴───────────────┘
Found: 4 node_modules
Total: 1 GB
Remove ALL listed node_modules? (y/n):
```

---

## Options

| Option              | Description                                |
| ------------------- | ------------------------------------------ |
| `-p, --path <path>` | Root path to scan **(required)**           |
| `-y, --yes`         | Skip confirmation and delete immediately  |
| `--json`            | Output results as JSON                     |
| `--max-depth <n>`   | Limit directory traversal depth            |
| `--follow-symlinks` | Follow symbolic links (disabled by default)|

---

## Safety

- Prompts for explicit `y/n` confirmation before any deletion
- Never traverses inside `node_modules` — only detects and measures
- Skips `.git` and `.cache` directories during scanning
- Does not follow symlinks by default to prevent accidents
- Uses robust deletion with automatic retries

---

## Requirements

- Node.js 18+
- macOS, Linux, or Windows

---

## License

MIT
