import {
  Editor,
  EditorChange,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_HIGHLIGHT_INDEX = "highlight-index-view";

type HighlightColor = "yellow" | "red";
type RequestedAction = HighlightColor | "unhighlight";
type HighlightStyle = "lowlight" | "floating" | "realistic" | "rounded";

const ALL_STYLES: HighlightStyle[] = ["lowlight", "floating", "realistic", "rounded"];

const COLORS: HighlightColor[] = ["yellow", "red"];
const ALL_ACTIONS: RequestedAction[] = ["yellow", "red", "unhighlight"];

function actionLabel(action: RequestedAction): string {
  return action === "unhighlight" ? "Unhighlight" : action.charAt(0).toUpperCase() + action.slice(1);
}

const WRAPPERS: Record<HighlightColor, { open: string; close: string; section: string }> = {
  yellow: { open: "==", close: "==", section: "## Highlighted yellow" },
  red: { open: '<mark class="hl-red">', close: "</mark>", section: "## Highlighted red" },
};

const FORMATTING_GAP = "(?:[*_`~\\[\\]=]+)?";

interface HighlightSettings {
  highlightsFile: string;
  maxSnippetLength: number;
  enableIndex: boolean;
  highlightStyle: HighlightStyle;
}

const DEFAULT_SETTINGS: HighlightSettings = {
  highlightsFile: "Highlighted.md",
  maxSnippetLength: 100,
  enableIndex: true,
  highlightStyle: "lowlight",
};

interface Match {
  start: number;
  end: number;
}

type BlockType = "list-item" | "heading" | "table-row" | "callout" | "paragraph";

interface BlockInfo {
  start: number;
  end: number;
  type: BlockType;
  idInsertOffset: number;
  idInsertPrefix: string;
}

interface Change {
  start: number;
  end: number;
  text: string;
}

type ComputeAction =
  | { kind: "wrap"; color: HighlightColor }
  | { kind: "unwrap"; color: HighlightColor }
  | { kind: "swap"; from: HighlightColor; to: HighlightColor }
  | { kind: "none" };

interface ComputeResult {
  changes: Change[];
  action: ComputeAction;
  blockId: string | null;
  matchedText: string;
  refusalReason: string | null;
}

interface LastAction {
  file: TFile;
  text: string;
  rangeRect: DOMRect;
  timestamp: number;
}

const LAST_ACTION_TTL_MS = 15000;

export default class HighlightPlugin extends Plugin {
  settings: HighlightSettings = DEFAULT_SETTINGS;
  private floatingContainer: HTMLElement | null = null;
  private storedRange: Range | null = null;
  private lastAction: LastAction | null = null;

  async onload() {
    await this.loadSettings();
    this.applyStyleClass();
    this.addSettingTab(new HighlightSettingTab(this));

    for (const action of ALL_ACTIONS) {
      const id = action === "unhighlight" ? "unhighlight-selection" : `highlight-selection-${action}`;
      const name =
        action === "unhighlight" ? "Unhighlight selection" : `Highlight selection (${action})`;
      const icon = action === "unhighlight" ? "eraser" : "highlighter";
      this.addCommand({
        id,
        name,
        icon,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view || !view.file) return false;
          if (view.getMode() === "source") {
            if (!view.editor.getSelection()) return false;
            if (!checking) void this.runFromEditor(view, action);
            return true;
          }
          const sel = window.getSelection();
          if (!sel || !sel.toString().trim()) return false;
          if (!checking) void this.runFromReading(view.file, sel, action);
          return true;
        },
      });
    }

    this.registerView(VIEW_TYPE_HIGHLIGHT_INDEX, (leaf) => new HighlightIndexView(leaf, this));

    this.addCommand({
      id: "open-highlights-index",
      name: "Toggle Highlighted sidebar",
      icon: "highlighter",
      callback: () => void this.toggleHighlightView(),
    });

    this.addRibbonIcon("highlighter", "Toggle Highlighted", () => void this.toggleHighlightView());

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, info) => {
        if (!(info instanceof MarkdownView)) return;
        if (!info.editor.getSelection()) return;
        const view = info;
        for (const action of ALL_ACTIONS) {
          const title = action === "unhighlight" ? "Unhighlight" : `Highlight ${action}`;
          const icon = action === "unhighlight" ? "eraser" : "highlighter";
          menu.addItem((item) =>
            item
              .setTitle(title)
              .setIcon(icon)
              .onClick(() => void this.runFromEditor(view, action))
          );
        }
      })
    );

    if (Platform.isMobile) {
      this.setupFloatingButtons();
    } else {
      this.registerDomEvent(document, "contextmenu", (evt) => this.onReadingContextMenu(evt));
    }
  }

  onunload(): void {
    this.removeFloatingButtons();
    this.removeStyleClass();
  }

  applyStyleClass(): void {
    const body = document.body;
    for (const s of ALL_STYLES) body.classList.remove(`highlight-style-${s}`);
    body.classList.add(`highlight-style-${this.settings.highlightStyle}`);
  }

  removeStyleClass(): void {
    const body = document.body;
    for (const s of ALL_STYLES) body.classList.remove(`highlight-style-${s}`);
  }

  refreshHighlightViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_HIGHLIGHT_INDEX);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof HighlightIndexView) void view.render();
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async toggleHighlightView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HIGHLIGHT_INDEX);
    if (existing.length > 0) {
      for (const leaf of existing) leaf.detach();
      return;
    }

    const path = this.settings.highlightsFile;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.app.vault.create(path, initialIndexContent(path));
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_HIGHLIGHT_INDEX, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private onReadingContextMenu(evt: MouseEvent): void {
    if (Platform.isMobile) return;
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    const readingContainer = target.closest(
      ".markdown-reading-view, .markdown-preview-view"
    ) as HTMLElement | null;
    if (!readingContainer) return;

    const sel = window.getSelection();
    if (!sel || !sel.toString().trim() || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!readingContainer.contains(range.commonAncestorContainer)) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;
    const file = view.file;

    evt.preventDefault();

    const menu = new Menu();
    for (const action of ALL_ACTIONS) {
      const title = action === "unhighlight" ? "Unhighlight" : `Highlight ${action}`;
      const icon = action === "unhighlight" ? "eraser" : "highlighter";
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon(icon)
          .onClick(() => void this.runFromReading(file, sel, action))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private async runFromEditor(view: MarkdownView, action: RequestedAction): Promise<void> {
    const editor = view.editor;
    const selText = editor.getSelection();
    if (!selText) return;
    const file = view.file;
    if (!file) return;

    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const start = editor.posToOffset(from);
    const end = editor.posToOffset(to);
    const content = editor.getValue();
    const chosen: Match = { start, end };

    const isHighlightsFile = file.path === this.settings.highlightsFile;
    const result = computeChanges(content, chosen, isHighlightsFile, action);
    if (result.refusalReason) {
      new Notice(`Highlight: ${result.refusalReason}`);
      return;
    }
    if (result.changes.length === 0) return;

    applyChangesToEditor(editor, result.changes);
    await this.afterApply(file, result);
  }

  private async runFromReading(file: TFile, selection: Selection, action: RequestedAction): Promise<void> {
    const selText = selection.toString();
    if (!selText.trim()) return;

    const content = await this.app.vault.read(file);

    let matches = findExactMatches(content, selText);
    if (matches.length === 0) matches = findFuzzyMatches(content, selText);
    if (matches.length === 0) matches = findInStrippedContent(content, selText);

    if (matches.length === 0) {
      new Notice("Highlight: couldn't find selection in source");
      return;
    }

    const safe = matches.filter((m) => isSafeWrapPosition(content, m.start, m.end));
    if (safe.length === 0) {
      new Notice("Highlight: that text only appears inside links or code");
      return;
    }

    const chosen = safe.length === 1 ? safe[0] : pickClosestMatch(safe, content, selection);

    const isHighlightsFile = file.path === this.settings.highlightsFile;
    const result = computeChanges(content, chosen, isHighlightsFile, action);
    if (result.refusalReason) {
      new Notice(`Highlight: ${result.refusalReason}`);
      return;
    }
    if (result.changes.length === 0) return;

    const newContent = applyChangesToString(content, result.changes);
    await this.app.vault.modify(file, newContent);
    await this.afterApply(file, result);
  }

  private async afterApply(file: TFile, result: ComputeResult): Promise<void> {
    if (!this.settings.enableIndex) return;
    if (!result.blockId) return;
    if (file.path === this.settings.highlightsFile) return;

    switch (result.action.kind) {
      case "wrap":
        await this.appendHighlightEntry(file.basename, result.blockId, result.matchedText, result.action.color);
        break;
      case "unwrap":
        await this.removeHighlightEntry(file.basename, result.blockId, result.matchedText);
        break;
      case "swap":
        await this.removeHighlightEntry(file.basename, result.blockId, result.matchedText);
        await this.appendHighlightEntry(file.basename, result.blockId, result.matchedText, result.action.to);
        break;
      case "none":
        break;
    }
  }

  private async appendHighlightEntry(noteName: string, blockId: string, snippet: string, color: HighlightColor): Promise<void> {
    const path = this.settings.highlightsFile;
    const safeSnippet = sanitizeSnippet(snippet, this.settings.maxSnippetLength);
    const entry = `- [[${noteName}#^${blockId}|${safeSnippet}]]`;
    const heading = WRAPPERS[color].section;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.app.vault.create(path, initialIndexContent(path, color, entry));
      return;
    }

    const current = await this.app.vault.read(file);
    const lines = current.split("\n");
    const newLines = insertInSection(lines, heading, entry);
    await this.app.vault.modify(file, newLines.join("\n"));
  }

  private async removeHighlightEntry(noteName: string, blockId: string, snippet: string): Promise<void> {
    const path = this.settings.highlightsFile;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const idx = findEntryIndex(
      lines,
      noteName,
      blockId,
      sanitizeSnippet(snippet, this.settings.maxSnippetLength)
    );
    if (idx === -1) return;
    lines.splice(idx, 1);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  // Mobile floating buttons -----------------------------------------------------

  private setupFloatingButtons(): void {
    this.registerDomEvent(document, "selectionchange", () => this.updateFloatingButtons());
    this.registerDomEvent(document, "touchend", () => {
      window.setTimeout(() => this.updateFloatingButtons(), 80);
    });
    this.registerDomEvent(window, "scroll", () => this.hideFloatingButtons(), true);
    this.registerDomEvent(
      document,
      "touchstart",
      (e) => {
        if (!this.floatingContainer || this.floatingContainer.style.display === "none") return;
        if (this.floatingContainer.contains(e.target as Node)) return;
      },
      true
    );
  }

  private updateFloatingButtons(): void {
    const sel = window.getSelection();
    if (!sel || !sel.toString().trim() || sel.rangeCount === 0) {
      this.maybeHideFloatingButtons();
      return;
    }

    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as HTMLElement)
        : range.startContainer.parentElement;
    const readingContainer = startEl?.closest(
      ".markdown-reading-view, .markdown-preview-view"
    ) as HTMLElement | null;
    if (!readingContainer) {
      this.maybeHideFloatingButtons();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.maybeHideFloatingButtons();
      return;
    }

    this.storedRange = range.cloneRange();
    this.ensureFloatingButtons();
    this.positionFloatingButtons(rect);
  }

  private maybeHideFloatingButtons(): void {
    if (this.lastAction && Date.now() - this.lastAction.timestamp < LAST_ACTION_TTL_MS) return;
    this.hideFloatingButtons();
  }

  private ensureFloatingButtons(): void {
    if (this.floatingContainer) return;
    const container = document.createElement("div");
    container.className = "highlight-floating-container";

    for (const action of ALL_ACTIONS) {
      const btn = document.createElement("div");
      btn.className = `highlight-floating-btn highlight-floating-btn--${action}`;
      btn.setAttribute("role", "button");
      btn.setAttribute(
        "aria-label",
        action === "unhighlight" ? "Unhighlight selection" : `Highlight selection ${action}`
      );
      btn.textContent = actionLabel(action);
      btn.addEventListener(
        "touchend",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.onFloatingButtonTap(action);
        },
        { passive: false }
      );
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      container.appendChild(btn);
    }

    document.body.appendChild(container);
    this.floatingContainer = container;
  }

  private positionFloatingButtons(rect: DOMRect): void {
    if (!this.floatingContainer) return;
    const container = this.floatingContainer;
    container.style.display = "flex";
    const cRect = container.getBoundingClientRect();
    const margin = 12;
    const iosBubbleClearance = 60;

    let top = rect.top - iosBubbleClearance - cRect.height - margin;
    if (top < margin) {
      top = rect.bottom + iosBubbleClearance + margin;
      if (top + cRect.height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - cRect.height - margin);
      }
    }

    let left = rect.left + rect.width / 2 - cRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - cRect.width - margin));

    container.style.top = `${top}px`;
    container.style.left = `${left}px`;
  }

  private hideFloatingButtons(): void {
    if (this.floatingContainer) this.floatingContainer.style.display = "none";
  }

  private removeFloatingButtons(): void {
    if (this.floatingContainer) {
      this.floatingContainer.remove();
      this.floatingContainer = null;
    }
    this.storedRange = null;
    this.lastAction = null;
  }

  private async onFloatingButtonTap(action: RequestedAction): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      this.hideFloatingButtons();
      return;
    }

    const sel = window.getSelection();
    const hasFreshSelection =
      !!sel && !!sel.toString().trim() && !!this.storedRange;

    let actionedText: string | null = null;
    let actionedRect: DOMRect | null = null;

    if (hasFreshSelection) {
      actionedText = sel!.toString();
      actionedRect = this.storedRange!.getBoundingClientRect();
      sel!.removeAllRanges();
      sel!.addRange(this.storedRange!.cloneRange());
      await this.runFromReading(view.file, sel!, action);
    } else if (this.lastAction && Date.now() - this.lastAction.timestamp < LAST_ACTION_TTL_MS) {
      actionedText = this.lastAction.text;
      actionedRect = this.lastAction.rangeRect;
      await this.highlightTextInFile(this.lastAction.file, this.lastAction.text, action);
    }

    if (actionedText && actionedRect) {
      this.lastAction = {
        file: view.file,
        text: actionedText,
        rangeRect: actionedRect,
        timestamp: Date.now(),
      };
      this.positionFloatingButtons(actionedRect);
    } else {
      this.hideFloatingButtons();
    }
  }

  private async highlightTextInFile(file: TFile, text: string, action: RequestedAction): Promise<void> {
    const content = await this.app.vault.read(file);

    let chosen: Match | null = null;
    for (const wrapColor of COLORS) {
      const w = WRAPPERS[wrapColor];
      const wrapped = w.open + text + w.close;
      const idx = content.indexOf(wrapped);
      if (idx !== -1) {
        chosen = { start: idx + w.open.length, end: idx + w.open.length + text.length };
        break;
      }
    }
    if (!chosen) {
      const plainIdx = content.indexOf(text);
      if (plainIdx !== -1) chosen = { start: plainIdx, end: plainIdx + text.length };
    }
    if (!chosen) {
      const { stripped, map } = stripForSearch(content);
      const sidx = stripped.indexOf(text);
      if (sidx !== -1 && sidx + text.length - 1 < map.length) {
        chosen = { start: map[sidx], end: map[sidx + text.length - 1] + 1 };
      }
    }
    if (!chosen) return;

    const isHighlightsFile = file.path === this.settings.highlightsFile;
    const result = computeChanges(content, chosen, isHighlightsFile, action);
    if (result.refusalReason || result.changes.length === 0) return;

    const newContent = applyChangesToString(content, result.changes);
    await this.app.vault.modify(file, newContent);
    await this.afterApply(file, result);
  }
}

class HighlightIndexView extends ItemView {
  private plugin: HighlightPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: HighlightPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_HIGHLIGHT_INDEX;
  }

  getDisplayText(): string {
    return "Highlighted";
  }

  getIcon(): string {
    return "highlighter";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerEvent(
      this.plugin.app.vault.on("modify", (file: TAbstractFile) => {
        if (file.path === this.plugin.settings.highlightsFile) void this.render();
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on("create", (file: TAbstractFile) => {
        if (file.path === this.plugin.settings.highlightsFile) void this.render();
      })
    );
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("highlight-index-view");

    const path = this.plugin.settings.highlightsFile;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const empty = contentEl.createDiv({ cls: "highlight-index-empty" });
      empty.setText("No highlights yet. Right-click any text and pick Highlight yellow or red.");
      return;
    }

    const content = await this.plugin.app.vault.read(file);
    await MarkdownRenderer.render(this.plugin.app, content, contentEl, path, this);
  }
}

class HighlightSettingTab extends PluginSettingTab {
  private plugin: HighlightPlugin;

  constructor(plugin: HighlightPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Highlighted index file")
      .setDesc("Path (in vault) where highlight entries are appended.")
      .addText((text) =>
        text
          .setPlaceholder("Highlighted.md")
          .setValue(this.plugin.settings.highlightsFile)
          .onChange(async (value) => {
            const trimmed = value.trim() || DEFAULT_SETTINGS.highlightsFile;
            this.plugin.settings.highlightsFile = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max snippet length")
      .setDesc("Snippet text is truncated to this many characters.")
      .addSlider((slider) =>
        slider
          .setLimits(20, 300, 10)
          .setValue(this.plugin.settings.maxSnippetLength)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxSnippetLength = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maintain Highlighted index")
      .setDesc("Off: wrap text but skip index updates.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableIndex).onChange(async (value) => {
          this.plugin.settings.enableIndex = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Highlight style").setHeading();
    containerEl.createEl("div", {
      cls: "setting-item-description",
      text: "Visual treatment applied to highlighted text. Click an option to apply.",
    });

    const picker = containerEl.createDiv({ cls: "highlight-style-picker" });
    const styleLabels: Record<HighlightStyle, string> = {
      lowlight: "Lowlight (underlined)",
      floating: "Floating (drop shadow)",
      realistic: "Realistic (marker stroke)",
      rounded: "Rounded (pill)",
    };

    for (const style of ALL_STYLES) {
      const option = picker.createDiv({
        cls: `highlight-style-option highlight-style-option--${style}`,
      });
      if (this.plugin.settings.highlightStyle === style) option.addClass("is-active");

      const preview = option.createDiv({ cls: "highlight-style-preview" });
      preview.createSpan({ cls: `hl-preview-${style}-yellow`, text: "yellow text" });
      preview.appendText(" and ");
      preview.createSpan({ cls: `hl-preview-${style}-red`, text: "red text" });

      option.createDiv({ cls: "highlight-style-label", text: styleLabels[style] });

      option.addEventListener("click", async () => {
        this.plugin.settings.highlightStyle = style;
        await this.plugin.saveSettings();
        this.plugin.applyStyleClass();
        this.display();
      });
    }
  }
}

// Pure functions --------------------------------------------------------------

function computeChanges(
  content: string,
  chosen: Match,
  isHighlightsFile: boolean,
  requested: RequestedAction
): ComputeResult {
  const existing = detectExistingWrap(content, chosen.start, chosen.end);
  const matchedText = content.substring(chosen.start, chosen.end);

  const base: ComputeResult = {
    changes: [],
    action: { kind: "none" },
    blockId: null,
    matchedText,
    refusalReason: null,
  };

  if (requested === "unhighlight") {
    const cleaned = stripHighlightMarkers(matchedText);
    if (existing) {
      base.changes.push({
        start: chosen.start - existing.openLen,
        end: chosen.end + existing.closeLen,
        text: cleaned,
      });
      base.action = { kind: "unwrap", color: existing.color };
    } else if (cleaned !== matchedText) {
      base.changes.push({
        start: chosen.start,
        end: chosen.end,
        text: cleaned,
      });
      base.action = { kind: "unwrap", color: "yellow" };
    }
    if (!isHighlightsFile && base.changes.length > 0) {
      const block = findBlockInfo(content, chosen.start);
      base.blockId = getExistingBlockId(content.substring(block.start, block.end));
    }
    return base;
  }

  const requestedColor: HighlightColor = requested;

  if (existing) {
    if (existing.color === requestedColor) {
      base.changes.push({
        start: chosen.start - existing.openLen,
        end: chosen.end + existing.closeLen,
        text: matchedText,
      });
      base.action = { kind: "unwrap", color: existing.color };
    } else {
      const w = WRAPPERS[requestedColor];
      base.changes.push({
        start: chosen.start - existing.openLen,
        end: chosen.end + existing.closeLen,
        text: w.open + matchedText + w.close,
      });
      base.action = { kind: "swap", from: existing.color, to: requestedColor };
    }
    if (!isHighlightsFile) {
      const block = findBlockInfo(content, chosen.start);
      base.blockId = getExistingBlockId(content.substring(block.start, block.end));
    }
    return base;
  }

  if (isInsideCodeBlock(content, chosen.start) || isInsideCodeBlock(content, chosen.end)) {
    return { ...base, refusalReason: "can't highlight inside code" };
  }
  if (isInsideWikilink(content, chosen.start) || isInsideWikilink(content, chosen.end)) {
    return { ...base, refusalReason: "selection is inside a [[link]] — select the whole link instead" };
  }
  if (isInsideMarkdownLinkUrl(content, chosen.start) || isInsideMarkdownLinkUrl(content, chosen.end)) {
    return { ...base, refusalReason: "selection is inside a link URL — select the link text instead" };
  }

  const w = WRAPPERS[requestedColor];
  const cleanedText = stripHighlightMarkers(matchedText);
  base.changes.push({
    start: chosen.start,
    end: chosen.end,
    text: w.open + cleanedText + w.close,
  });
  base.action = { kind: "wrap", color: requestedColor };

  if (!isHighlightsFile) {
    const block = findBlockInfo(content, chosen.start);
    const existingId = getExistingBlockId(content.substring(block.start, block.end));
    if (existingId) {
      base.blockId = existingId;
    } else {
      base.blockId = generateBlockId();
      base.changes.push({
        start: block.idInsertOffset,
        end: block.idInsertOffset,
        text: `${block.idInsertPrefix}^${base.blockId}`,
      });
    }
  }

  return base;
}

function detectExistingWrap(
  content: string,
  start: number,
  end: number
): { color: HighlightColor; openLen: number; closeLen: number } | null {
  for (const color of COLORS) {
    const { open, close } = WRAPPERS[color];
    if (
      content.substring(Math.max(0, start - open.length), start) === open &&
      content.substring(end, end + close.length) === close
    ) {
      return { color, openLen: open.length, closeLen: close.length };
    }
  }
  return null;
}

function initialIndexContent(path: string, initialColor?: HighlightColor, entry?: string): string {
  const base = stripExt(path);
  let content = `# ${base}\n\n${WRAPPERS.yellow.section}\n\n${WRAPPERS.red.section}\n`;
  if (initialColor && entry) {
    const lines = content.split("\n");
    const updated = insertInSection(lines, WRAPPERS[initialColor].section, entry);
    content = updated.join("\n");
  }
  return content;
}

function insertInSection(lines: string[], heading: string, entry: string): string[] {
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    const result = [...lines];
    while (result.length > 0 && result[result.length - 1] === "") result.pop();
    result.push("", heading, "", entry);
    return result;
  }
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1] === "") insertAt--;
  return [...lines.slice(0, insertAt), entry, ...lines.slice(insertAt)];
}

function findEntryIndex(lines: string[], noteName: string, blockId: string, expectedSnippet: string): number {
  const prefix = `[[${noteName}#^${blockId}|`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(prefix)) continue;
    const startIdx = lines[i].indexOf(prefix);
    const afterPrefix = lines[i].substring(startIdx + prefix.length);
    const endIdx = afterPrefix.indexOf("]]");
    if (endIdx === -1) continue;
    const displayText = afterPrefix.substring(0, endIdx);
    if (displayText === expectedSnippet) return i;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(prefix)) return i;
  }
  return -1;
}

function applyChangesToString(content: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const c of sorted) {
    result += content.substring(cursor, c.start);
    result += c.text;
    cursor = c.end;
  }
  result += content.substring(cursor);
  return result;
}

function applyChangesToEditor(editor: Editor, changes: Change[]): void {
  const editorChanges: EditorChange[] = changes.map((c) => ({
    from: editor.offsetToPos(c.start),
    to: editor.offsetToPos(c.end),
    text: c.text,
  }));
  editor.transaction({ changes: editorChanges });
}

function sanitizeSnippet(text: string, max: number): string {
  const cleaned = stripHighlightMarkers(text);
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  const stripped = collapsed.replace(/[\[\]|]/g, "");
  return stripped.length > max ? stripped.substring(0, max) + "…" : stripped;
}

function findExactMatches(content: string, selText: string): Match[] {
  const matches: Match[] = [];
  let idx = content.indexOf(selText);
  while (idx !== -1) {
    matches.push({ start: idx, end: idx + selText.length });
    idx = content.indexOf(selText, idx + 1);
  }
  return matches;
}

function findInStrippedContent(content: string, selText: string): Match[] {
  const { stripped, map } = stripForSearch(content);
  const matches: Match[] = [];
  let idx = stripped.indexOf(selText);
  while (idx !== -1) {
    if (idx + selText.length <= map.length) {
      const start = map[idx];
      const end = idx + selText.length - 1 < map.length ? map[idx + selText.length - 1] + 1 : content.length;
      matches.push({ start, end });
    }
    idx = stripped.indexOf(selText, idx + 1);
  }
  return matches;
}

function stripForSearch(content: string): { stripped: string; map: number[] } {
  let stripped = "";
  const map: number[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] === "=" && content[i + 1] === "=") {
      i += 2;
      continue;
    }
    if (content.substring(i, i + 5) === "<mark") {
      const closeIdx = content.indexOf(">", i);
      if (closeIdx !== -1 && closeIdx - i < 300) {
        i = closeIdx + 1;
        continue;
      }
    }
    if (content.substring(i, i + 7) === "</mark>") {
      i += 7;
      continue;
    }
    stripped += content[i];
    map.push(i);
    i++;
  }
  return { stripped, map };
}

function stripHighlightMarkers(text: string): string {
  return text
    .replace(/==/g, "")
    .replace(/<mark\b[^>]*>/g, "")
    .replace(/<\/mark>/g, "");
}

function findFuzzyMatches(content: string, selText: string): Match[] {
  const regex = buildFlexibleRegex(selText);
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

function buildFlexibleRegex(selText: string): RegExp {
  const tokens = [...selText.trim()].map((c) => {
    if (/\s/.test(c)) return "\\s+";
    return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const pattern = FORMATTING_GAP + tokens.join(FORMATTING_GAP) + FORMATTING_GAP;
  return new RegExp(pattern, "g");
}

function pickClosestMatch(matches: Match[], content: string, selection: Selection): Match {
  if (selection.rangeCount === 0) return matches[0];
  const range = selection.getRangeAt(0);
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : range.startContainer.parentElement;
  const readingContainer = startEl?.closest(
    ".markdown-reading-view, .markdown-preview-view"
  ) as HTMLElement | null;
  if (!readingContainer) return matches[0];

  const totalRendered = (readingContainer.textContent ?? "").length;
  if (totalRendered === 0) return matches[0];

  let renderedPos = 0;
  const walker = document.createTreeWalker(readingContainer, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      renderedPos += range.startOffset;
      break;
    }
    renderedPos += (node.textContent ?? "").length;
  }

  const ratio = renderedPos / totalRendered;
  const estSourcePos = Math.floor(content.length * ratio);

  let best = matches[0];
  let bestDist = Math.abs(matches[0].start - estSourcePos);
  for (const m of matches) {
    const d = Math.abs(m.start - estSourcePos);
    if (d < bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

function findBlockInfo(content: string, position: number): BlockInfo {
  const lineStart = content.lastIndexOf("\n", position - 1) + 1;
  const lineEndRaw = content.indexOf("\n", position);
  const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
  const line = content.substring(lineStart, lineEnd);
  const type = classifyLine(line);

  if (type === "list-item" || type === "heading" || type === "table-row") {
    return {
      start: lineStart,
      end: lineEnd,
      type,
      idInsertOffset: lineEnd,
      idInsertPrefix: " ",
    };
  }

  if (type === "callout") {
    const { start, end } = expandCalloutBounds(content, lineStart, lineEnd);
    return {
      start,
      end,
      type,
      idInsertOffset: end,
      idInsertPrefix: "\n> ",
    };
  }

  let pStart = content.lastIndexOf("\n\n", position);
  pStart = pStart === -1 ? 0 : pStart + 2;
  let pEnd = content.indexOf("\n\n", position);
  pEnd = pEnd === -1 ? content.length : pEnd;
  return {
    start: pStart,
    end: pEnd,
    type: "paragraph",
    idInsertOffset: pEnd,
    idInsertPrefix: " ",
  };
}

function classifyLine(line: string): BlockType | null {
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) return "list-item";
  if (/^#{1,6}\s/.test(line)) return "heading";
  if (/^\s*\|/.test(line) && line.lastIndexOf("|") > 0) return "table-row";
  if (/^>/.test(line)) return "callout";
  return null;
}

function expandCalloutBounds(content: string, lineStart: number, lineEnd: number): { start: number; end: number } {
  let start = lineStart;
  while (start > 0) {
    const prevLineEnd = start - 1;
    const prevLineStart = content.lastIndexOf("\n", prevLineEnd - 1) + 1;
    if (prevLineStart > prevLineEnd) break;
    const prevLine = content.substring(prevLineStart, prevLineEnd);
    if (!/^>/.test(prevLine)) break;
    start = prevLineStart;
  }
  let end = lineEnd;
  while (end < content.length) {
    const nextLineStart = end + 1;
    if (nextLineStart > content.length) break;
    const nextLineEndRaw = content.indexOf("\n", nextLineStart);
    const nextLineEnd = nextLineEndRaw === -1 ? content.length : nextLineEndRaw;
    const nextLine = content.substring(nextLineStart, nextLineEnd);
    if (!/^>/.test(nextLine)) break;
    end = nextLineEnd;
  }
  return { start, end };
}

function getExistingBlockId(blockText: string): string | null {
  const match = blockText.match(/\^([a-zA-Z0-9-]+)\s*$/);
  return match ? match[1] : null;
}

function generateBlockId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function isSafeWrapPosition(content: string, start: number, end: number): boolean {
  return (
    !isInsideWikilink(content, start) &&
    !isInsideWikilink(content, end) &&
    !isInsideCodeBlock(content, start) &&
    !isInsideCodeBlock(content, end) &&
    !isInsideMarkdownLinkUrl(content, start) &&
    !isInsideMarkdownLinkUrl(content, end)
  );
}

function isInsideCodeBlock(content: string, position: number): boolean {
  const before = content.substring(0, position);
  const fenceMatches = before.match(/^[ \t]*(```|~~~)/gm);
  if (fenceMatches && fenceMatches.length % 2 === 1) return true;

  const lineStart = content.lastIndexOf("\n", position - 1) + 1;
  const segment = content.substring(lineStart, position);
  let inInline = false;
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "`") {
      let count = 1;
      while (i + count < segment.length && segment[i + count] === "`") count++;
      inInline = !inInline;
      i += count;
    } else {
      i++;
    }
  }
  return inInline;
}

function isInsideWikilink(content: string, position: number): boolean {
  const before = content.substring(0, position);
  const lastOpen = before.lastIndexOf("[[");
  if (lastOpen === -1) return false;
  const lastClose = before.lastIndexOf("]]");
  return lastClose < lastOpen;
}

function isInsideMarkdownLinkUrl(content: string, position: number): boolean {
  const lineStart = content.lastIndexOf("\n", position - 1) + 1;
  const segment = content.substring(lineStart, position);
  const lastOpenParen = segment.lastIndexOf("(");
  if (lastOpenParen <= 0) return false;
  if (segment[lastOpenParen - 1] !== "]") return false;
  const closeAfter = segment.indexOf(")", lastOpenParen);
  return closeAfter === -1;
}

function stripExt(path: string): string {
  return path.replace(/\.md$/i, "").split("/").pop() ?? path;
}
