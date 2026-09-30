const {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  folder: "Characters/DiceCloud",
  characterPaths: {},
};

const API_ROOT = "https://dicecloud.com/api/creature/";
const CHARACTER_ROOT = "https://dicecloud.com/character/";

class DiceCloudImporter extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.characterPaths = Object.assign(
      {},
      DEFAULT_SETTINGS.characterPaths,
      this.settings.characterPaths || {}
    );

    this.addRibbonIcon("download", "Import DiceCloud character", () =>
      this.openImportModal()
    );

    this.addCommand({
      id: "import-character",
      name: "Import public DiceCloud character",
      callback: () => this.openImportModal(),
    });

    this.addCommand({
      id: "refresh-current-character",
      name: "Refresh current note from DiceCloud",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        if (!file) return false;
        if (!checking) this.refreshFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "add-current-to-initiative-tracker",
      name: "Add current character to Initiative Tracker",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        const frontmatter = file && this.getFrontmatter(file);
        if (!frontmatter?.["dicecloud-id"]) return false;
        if (!checking) this.addCurrentToTracker(file, false);
        return true;
      },
    });

    this.addCommand({
      id: "start-encounter-with-current-character",
      name: "Start Initiative Tracker encounter with current character",
      checkCallback: (checking) => {
        const file = this.getActiveFile();
        const frontmatter = file && this.getFrontmatter(file);
        if (!frontmatter?.["dicecloud-id"]) return false;
        if (!checking) this.addCurrentToTracker(file, true);
        return true;
      },
    });

    this.addSettingTab(new DiceCloudSettingTab(this.app, this));
  }

  openImportModal() {
    new DiceCloudImportModal(this.app, async (input) => {
      await this.importCharacter(input);
    }).open();
  }

  async importCharacter(input, targetFile) {
    let source;
    try {
      source = parseDiceCloudInput(input);
    } catch (error) {
      new Notice(error.message);
      return;
    }

    const notice = new Notice("Fetching DiceCloud character…", 0);
    try {
      const payload = await fetchCharacter(source.id);
      const character = normalizeCharacter(payload, source);
      const existing = targetFile || this.getRememberedCharacterFile(source.id);
      const oldFrontmatter = existing ? this.getFrontmatter(existing) : {};
      const currentHp = numberOrUndefined(oldFrontmatter?.["current-hp"]);
      const path = existing?.path ||
        normalizePath(`${this.settings.folder}/${slugify(character.name)}.md`);

      await this.ensureFolder(this.settings.folder);
      const content = renderCharacterNote(character, {
        currentHp: currentHp ?? character.hp.maximum,
      });

      let file;
      if (existing) {
        await this.app.vault.modify(existing, content);
        file = existing;
      } else {
        file = await this.app.vault.create(path, content);
      }

      this.settings.characterPaths[source.id] = file.path;
      await this.saveSettings();

      notice.hide();
      new Notice(`${existing ? "Updated" : "Imported"}: ${character.name}`);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      notice.hide();
      console.error("DiceCloud Character Importer", error);
      new Notice(`DiceCloud import failed: ${error.message || error}`);
    }
  }

  async refreshFile(file) {
    const frontmatter = this.getFrontmatter(file);
    const id = frontmatter?.["dicecloud-id"];
    if (!id) {
      new Notice("The current note has no dicecloud-id in its frontmatter.");
      return;
    }
    await this.importCharacter(id, file);
  }

  getRememberedCharacterFile(id) {
    const path = this.settings.characterPaths?.[id];
    const file = path && this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && file.extension === "md" ? file : undefined;
  }

  getActiveFile() {
    const file = this.app.workspace.getActiveFile();
    return file instanceof TFile && file.extension === "md" ? file : undefined;
  }

  getFrontmatter(file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter || {};
  }

  async addCurrentToTracker(file, startEncounter) {
    const fm = this.getFrontmatter(file);
    const creature = {
      name: String(fm.name || file.basename),
      hp: numberOrUndefined(fm.hp) ?? 0,
      ac: numberOrUndefined(fm.ac) ?? fm.ac ?? 10,
      modifier: numberOrUndefined(fm.modifier) ?? 0,
      level: numberOrUndefined(fm.level),
      player: true,
      path: file.path,
      note: file.path,
      "statblock-link": `${file.path}#^statblock`,
    };

    try {
      if (startEncounter) {
        this.app.workspace.trigger("initiative-tracker:start-encounter", [
          creature,
        ]);
      } else if (window.InitiativeTracker?.addCreatures) {
        window.InitiativeTracker.addCreatures([creature], false);
      } else {
        throw new Error(
          "Initiative Tracker is not loaded. Enable it and reload Obsidian."
        );
      }
      new Notice(`${startEncounter ? "Started encounter with" : "Added"} ${creature.name}`);
    } catch (error) {
      console.error("DiceCloud Character Importer", error);
      new Notice(`Could not use Initiative Tracker: ${error.message || error}`);
    }
  }

  async ensureFolder(folder) {
    const clean = normalizePath(folder).replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    let current = "";
    for (const part of clean.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class DiceCloudSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "DiceCloud Character Importer" });
    new Setting(containerEl)
      .setName("Character folder")
      .setDesc("Folder where imported character notes are created.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.folder)
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim() || DEFAULT_SETTINGS.folder;
            await this.plugin.saveSettings();
          })
      );
    containerEl.createEl("p", {
      text: "Only public DiceCloud v2 data is requested. No credentials are used and the importer never writes to DiceCloud.",
    });
  }
}

class DiceCloudImportModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Import DiceCloud character" });
    contentEl.createEl("p", {
      text: "Paste a public DiceCloud v2 character URL or its character ID.",
    });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "https://dicecloud.com/character/... or ID",
    });
    input.addClass("dicecloud-import-input");

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = buttons.createEl("button", {
      text: "Import",
      cls: "mod-cta",
    });
    submit.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) {
        new Notice("Enter a DiceCloud URL or character ID.");
        return;
      }
      submit.disabled = true;
      try {
        await this.onSubmit(value);
        this.close();
      } finally {
        submit.disabled = false;
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit.click();
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

async function fetchCharacter(id) {
  const response = await requestUrl({
    url: `${API_ROOT}${encodeURIComponent(id)}`,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`DiceCloud returned HTTP ${response.status}.`);
  }
  const payload = response.json;
  if (!payload || !Array.isArray(payload.creatures) || !payload.creatures.length) {
    throw new Error("The response did not contain a public character.");
  }
  return payload;
}

function parseDiceCloudInput(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Enter a DiceCloud URL or character ID.");

  let id = value;
  let sourceUrl = `${CHARACTER_ROOT}${value}`;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("That is not a valid URL.");
    }
    if (!/dicecloud\.com$/i.test(url.hostname) && !/\.dicecloud\.com$/i.test(url.hostname)) {
      throw new Error("Use a public dicecloud.com character URL.");
    }
    const match = url.pathname.match(/\/(?:character|api\/creature)\/([^/]+)/i);
    if (!match) throw new Error("Could not find a DiceCloud character ID in that URL.");
    id = decodeURIComponent(match[1]);
    sourceUrl = value;
  }

  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) {
    throw new Error("The DiceCloud character ID does not look valid.");
  }
  return { id, sourceUrl };
}

function normalizeCharacter(payload, source) {
  const creature = payload.creatures[0];
  const variables = payload.creatureVariables?.[0] || {};
  const properties = Array.isArray(payload.creatureProperties)
    ? payload.creatureProperties
    : [];

  const get = (name) => variableValue(variables[name]);
  const hpMax = numberOrUndefined(get("hitPoints")) ?? 0;
  const hpCurrent = numberOrUndefined(variableValue(variables.hitPoints, "value")) ?? hpMax;
  const abilities = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
  const stats = abilities.map((name) => numberOrUndefined(get(name)) ?? 0);

  const skills = collectProperties(properties, variables, "skill", ["Initiative"]);
  const saves = collectSavingThrows(properties, variables);
  const traits = collectNamed(properties, "feature");
  const actions = collectNamed(properties, "action");
  const spells = collectNamed(properties, "spell");
  const items = collectNamed(properties, "item");
  const classes = Object.values(variables)
    .filter((value) => value && value.type === "class" && value.level > 0)
    .map((value) => `${value.name || value.variableName} ${value.level}`)
    .filter((value, index, array) => array.indexOf(value) === index);

  const race = get("race");
  const level = numberOrUndefined(get("level"));
  const size = sizeName(get("creatureSize"));
  const type = creatureTypeName(get("creatureType"));
  const speed = numberOrUndefined(get("speed"));
  const ac = numberOrUndefined(get("armor"));
  const initiative = numberOrUndefined(get("initiative"));
  const proficiency = numberOrUndefined(get("proficiencyBonus"));
  const spellDc = numberOrUndefined(get("wizardSpellDC"));
  const spellAttack = numberOrUndefined(get("wizardSpellAttackBonus"));
  const image = creature.picture || creature.avatarPicture;
  const slots = [];
  for (let levelNumber = 1; levelNumber <= 9; levelNumber++) {
    const max = numberOrUndefined(get(`slotLevel${levelNumber}`));
    if (max !== undefined && max > 0) slots.push({ level: levelNumber, max });
  }

  return {
    id: source.id,
    sourceUrl: source.sourceUrl,
    fetchedAt: new Date().toISOString(),
    name: creature.name || `DiceCloud ${source.id}`,
    gender: creature.gender,
    alignment: creature.alignment,
    race: typeof race === "string" ? race : undefined,
    classes,
    level,
    size,
    type,
    hp: { maximum: hpMax, current: hpCurrent },
    ac,
    initiative,
    speed,
    proficiency,
    spellDc,
    spellAttack,
    stats,
    skills,
    saves,
    traits,
    actions,
    spells,
    items,
    slots,
    image,
    propertyCount: properties.length,
    variableCount: Object.keys(variables).length,
  };
}

function variableValue(variable, preferredKey) {
  if (variable === undefined || variable === null) return undefined;
  if (typeof variable === "string" || typeof variable === "number" || typeof variable === "boolean") {
    return variable;
  }
  if (preferredKey && isScalar(variable[preferredKey])) return variable[preferredKey];
  for (const key of ["total", "value", "level"]) {
    if (isScalar(variable[key])) return variable[key];
    if (variable[key] && isScalar(variable[key].value)) return variable[key].value;
  }
  if (variable.baseValue && isScalar(variable.baseValue.value)) return variable.baseValue.value;
  return undefined;
}

function isScalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function collectProperties(properties, variables, type, excludedNames = []) {
  const result = {};
  for (const property of properties) {
    if (property.type !== type || !property.name) continue;
    if (excludedNames.some((name) => name.toLowerCase() === property.name.toLowerCase())) continue;
    const key = property.name;
    if (Object.prototype.hasOwnProperty.call(result, key)) continue;
    const value = variableValue(variables[property.variableName]) ?? property.value;
    if (typeof value === "number") result[key] = value;
  }
  return result;
}

function collectSavingThrows(properties, variables) {
  const result = {};
  for (const property of properties) {
    if (property.type !== "savingThrow") continue;
    const name = String(property.name || "").replace(/\s+Save$/i, "");
    if (!name || Object.prototype.hasOwnProperty.call(result, name)) continue;
    const value = variableValue(variables[property.variableName]) ?? property.value;
    if (typeof value === "number") result[name] = value;
  }
  return result;
}

function collectNamed(properties, type) {
  const result = [];
  const seen = new Set();
  for (const property of properties) {
    if (property.type !== type || !property.name) continue;
    const name = String(property.name).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const description = property.description?.value || property.description?.text || "";
    result.push({ name, desc: cleanText(description) });
  }
  return result;
}

function cleanText(value) {
  return String(value || "")
    .replace(/```/g, "'''")
    .replace(/\u0000/g, "")
    .trim();
}

function renderCharacterNote(character, options = {}) {
  const maxHp = character.hp.maximum || 0;
  const currentHp = options.currentHp ?? character.hp.current ?? maxHp;
  const statblock = {
    name: character.name,
    size: character.size || "Medium",
    type: character.type || "humanoid",
    alignment: character.alignment || "Unaligned",
    ac: character.ac ?? 10,
    hp: maxHp,
    modifier: character.initiative ?? 0,
    level: character.level,
    player: true,
    stats: character.stats,
    speed: character.speed ? `${character.speed} ft.` : undefined,
    skillsaves: Object.entries(character.skills).map(([name, value]) => ({ [name.toLowerCase().replace(/ /g, "_")]: value })),
    saves: Object.entries(character.saves).map(([name, value]) => ({ [name.toLowerCase()]: value })),
    // Keep the Fantasy Statblock focused on combat summary. The complete
    // DiceCloud feature/action/spell lists remain in the Markdown sections
    // below the statblock, but are not rendered inside it.
    source: "DiceCloud v2",
    image: character.image,
  };
  for (const key of Object.keys(statblock)) {
    if (statblock[key] === undefined || statblock[key] === null || (Array.isArray(statblock[key]) && !statblock[key].length)) {
      delete statblock[key];
    }
  }

  const lines = [
    "---",
    "obsidianUIMode: preview",
    "cssclasses:",
    "  - dicecloud-character",
    "  - player-character",
    "statblock: inline",
    "statblock-link: \"#^statblock\"",
    "player: true",
    `name: ${yamlScalar(character.name)}`,
    `level: ${character.level ?? 0}`,
    `ac: ${character.ac ?? 10}`,
    `hp: ${maxHp}`,
    `current-hp: ${currentHp}`,
    `modifier: ${character.initiative ?? 0}`,
    `dicecloud-id: ${yamlScalar(character.id)}`,
    `dicecloud-url: ${yamlScalar(character.sourceUrl)}`,
    `dicecloud-last-sync: ${yamlScalar(character.fetchedAt.slice(0, 10))}`,
    "---",
    "",
    `# ${character.name}`,
    "",
    `Source: [DiceCloud](${character.sourceUrl})`,
    "",
    "```statblock",
    JSON.stringify(statblock, null, 2),
    "```",
    "^statblock",
    "",
    "## Summary",
    "",
    `- **Class(es):** ${character.classes.length ? character.classes.join(", ") : "—"}`,
    `- **Race:** ${character.race || "—"}`,
    `- **Alignment:** ${character.alignment || "—"}`,
    `- **HP:** ${currentHp}/${maxHp}`,
    `- **AC:** ${character.ac ?? "—"}`,
    `- **Initiative:** ${signed(character.initiative ?? 0)}`,
    `- **Speed:** ${character.speed ? `${character.speed} ft.` : "—"}`,
    `- **Proficiency Bonus:** ${signed(character.proficiency ?? 0)}`,
    "",
    "## Ability Scores",
    "",
    "| Ability | Score | Modifier |",
    "|---|---:|---:|",
  ];

  const abilityNames = ["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"];
  character.stats.forEach((score, index) => {
    lines.push(`| ${abilityNames[index]} | ${score} | ${signed(abilityModifier(score))} |`);
  });

  appendNumberTable(lines, "Skills", character.skills);
  appendNumberTable(lines, "Saving Throws", character.saves);

  lines.push("", "## Spells & Resources", "");
  if (character.spellDc || character.spellAttack) {
    lines.push(`- **Spell Save DC:** ${character.spellDc ?? "—"}`);
    lines.push(`- **Spell Attack Bonus:** ${signed(character.spellAttack ?? 0)}`);
  }
  if (character.slots.length) {
    lines.push("", "| Level | Maximum Slots |", "|---:|---:|");
    for (const slot of character.slots) lines.push(`| ${slot.level} | ${slot.max} |`);
  }
  if (!character.spellDc && !character.spellAttack && !character.slots.length) lines.push("No calculated spellcasting data.");

  appendEntries(lines, "Features", character.traits);
  appendEntries(lines, "Actions", character.actions);
  appendEntries(lines, "Spells", character.spells);
  appendEntries(lines, "Inventory", character.items);

  lines.push(
    "## Synchronization",
    "",
    `- **Properties received:** ${character.propertyCount}`,
    `- **Calculated variables received:** ${character.variableCount}`,
    "- This note is a DiceCloud projection for reference and combat.",
    "- Use **Refresh current note from DiceCloud** to update public data.",
    "- Initiative Tracker uses `hp`, `ac`, `modifier`, `level` and `player`; this note's current HP is preserved during refresh.",
    ""
  );

  return lines.join("\n");
}

function appendNumberTable(lines, title, values) {
  lines.push("", `## ${title}`, "");
  if (!Object.keys(values).length) {
    lines.push("No calculated data.");
    return;
  }
  lines.push("| Name | Bonus |", "|---|---:|");
  for (const [name, value] of Object.entries(values)) lines.push(`| ${name} | ${signed(value)} |`);
}

function appendEntries(lines, title, entries) {
  lines.push("", `## ${title}`, "");
  if (!entries.length) {
    lines.push("No imported entries.");
    return;
  }
  for (const entry of entries) {
    lines.push(`### ${entry.name}`);
    if (entry.desc) lines.push("", entry.desc);
    lines.push("");
  }
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function abilityModifier(score) {
  return Math.floor((Number(score) - 10) / 2);
}

function signed(value) {
  const number = Number(value) || 0;
  return number >= 0 ? `+${number}` : String(number);
}

function numberOrUndefined(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sizeName(value) {
  return ({ 1: "Tiny", 2: "Small", 3: "Medium", 4: "Large", 5: "Huge", 6: "Gargantuan" })[value] || "Medium";
}

function creatureTypeName(value) {
  return ({ 0: "humanoid", 1: "aberration", 2: "beast", 3: "celestial", 4: "construct", 5: "dragon", 6: "elemental", 7: "fey", 8: "fiend", 9: "giant", 10: "monstrosity", 11: "ooze", 12: "plant", 13: "undead" })[value] || "humanoid";
}

function slugify(value) {
  return String(value || "DiceCloud Character")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "DiceCloud-Character";
}

module.exports = DiceCloudImporter;
