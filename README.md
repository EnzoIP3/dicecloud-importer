# DiceCloud Character Importer

An Obsidian plugin that imports public DiceCloud v2 characters into Markdown notes compatible with Fantasy Statblocks and Initiative Tracker.

## Features

- Imports a public DiceCloud v2 URL or character ID.
- Uses the public REST endpoint without credentials.
- Creates a readable character note with combat summary, abilities, skills, saves, spells, traits, actions and inventory.
- Keeps the Fantasy Statblocks block focused on combat data instead of dumping every DiceCloud property into it.
- Adds an imported character to Initiative Tracker.
- Refreshes a character while preserving the local `current-hp` value.
- Never writes to DiceCloud.

## Installation

### Manual installation

Copy `main.js` and `manifest.json` into:

```text
<Vault>/.obsidian/plugins/dicecloud-importer/
```

Then enable **DiceCloud Character Importer** under **Settings → Community plugins**.

### Community plugins

Once published, it can be installed from Obsidian's Community plugins browser.

## Usage

Open the command palette (`Ctrl+P` on Windows/Linux or `Cmd+P` on macOS) and run:

- **Import public DiceCloud character**
- **Refresh current note from DiceCloud**
- **Add current character to Initiative Tracker**
- **Start Initiative Tracker encounter with current character**

The default destination folder is `Characters/DiceCloud/`. It can be changed in the plugin settings.

## Privacy

The plugin only requests:

```text
GET https://dicecloud.com/api/creature/{characterId}
```

It does not request or store DiceCloud credentials and does not modify DiceCloud. Only public characters can be imported.

## Limitations

DiceCloud is a calculation engine and its full property tree cannot be represented losslessly as a Fantasy Statblock. The generated statblock is intentionally a combat summary; the complete imported projection remains in Markdown sections below it.

## License

MIT. See [LICENSE](./LICENSE).
