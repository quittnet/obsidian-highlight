# Highlight: Obsidian plugin

Highlight selected text **yellow** or **red** in any note. Every highlight is auto-logged to a `Highlighted.md` index file with block-precision links so you can jump back to anything you've highlighted.

Works in **Read mode** and **Edit mode**, on **desktop**, **iPhone**, and **iPad**.

## Features

- **Right-click** selected text → **Highlight yellow** / **Highlight red** / **Unhighlight** (works in both Read view and Edit view)
- **Mobile**: floating yellow / red / unhighlight pill buttons appear over text selections in Read view
- Three commands (`Highlight selection (yellow)` / `(red)` / `Unhighlight selection`) for binding hotkeys or pinning to the mobile keyboard toolbar
- **Per-color toggle**: clicking the same color removes the highlight; clicking the other color swaps it; tapping **Unhighlight** strips any color (and also clears nested markers in a multi-highlighted span)
- Auto-maintains an index file (`Highlighted.md` by default) with `## Highlighted yellow` and `## Highlighted red` sections
- Each index entry is a **block-precision link**. Clicking it jumps to the exact paragraph in the source note
- **Right sidebar panel**: clicking the highlighter ribbon icon (or running `Toggle Highlighted sidebar`) opens the index in a sidebar panel with the same clickable links. Click the icon again to close it. Panel auto-refreshes whenever you add or remove a highlight.
- **Highlight style picker**: choose between four visual presets for how highlights look. Settings tab shows a live yellow + red sample for each:
  - **Lowlight**: thick colored underline, no background fill
  - **Floating**: solid color with a soft drop shadow (like a sticky note)
  - **Realistic**: gradient covers the bottom of the text, like a real marker stroke
  - **Rounded**: pill-shaped capsule with rounded corners
- Refuses safely (with notice) when wrap would break markdown: inside code blocks, inside `[[wikilinks]]`, inside link URLs

## Install via BRAT

The plugin isn't in the official Obsidian Community Plugins marketplace yet. Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) to install:

1. Install **BRAT** from Settings → Community plugins → Browse → search "BRAT"
2. Enable BRAT
3. Open BRAT settings → **Add Beta Plugin**
4. Paste: `quittnet/obsidian-highlight`
5. Enable **Highlight** under Settings → Community plugins

BRAT will auto-update the plugin when new releases ship.

## Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/quittnet/obsidian-highlight/releases)
2. Drop them into `<your-vault>/.obsidian/plugins/yellow-highlight/`
3. Enable **Highlight** in Settings → Community plugins

## Settings

- **Highlighted index file**: rename the index file path (default `Highlighted.md`)
- **Max snippet length**: how long entries in the index can be (default 100 chars)
- **Maintain Highlighted index**: turn off if you want the highlight wraps without the index
- **Highlight style**: pick one of four visual styles (Lowlight, Floating, Realistic, Rounded). Each option in the picker shows a live preview of yellow and red text in that style

## Storage format

- **Yellow** uses Obsidian's native highlight markdown: `==text==`
- **Red** uses inline HTML: `<mark class="hl-red">text</mark>` styled by `styles.css`
- A 6-character **block ID** (`^abc123`) is auto-appended to the source paragraph the first time you highlight in it, so index links jump precisely. List items, headings, table rows, and callouts get the block ID on their own line so the link resolves to the right block.

## Caveats

- The iOS native selection bubble (Copy / Look Up / Share) cannot be modified. That's a UIKit limitation, not the plugin's. The mobile floating button is the closest substitute.
- Highlighting text that's inside a `[[wikilink]]` is refused with a notice. Select the whole `[[wikilink]]` instead and the wrap goes around the link as a unit.

## License

[MIT](LICENSE)
