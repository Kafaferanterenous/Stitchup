//! The command registry: every ribbon button, menu item and keyboard shortcut
//! is defined once here (labels, tooltips and tab placement follow the
//! Windows build so both look and behave the same).

import { getState, store, isUntitled, docName, type AppState, type RibbonTabName, type Tool } from "./store";
import { extractTo, pickAndOpen, saveAs } from "./actions";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toggleDark } from "./themes/theme";
import type { IconName } from "./features/ribbon/icons";
import * as exp from "./export";
import { cmdCheckUpdate, cmdOpenUrl, cmdReadImage, cmdWriteFile } from "./ipc";

import { language, tr } from "./i18n";

export interface Command {
  id: string;
  /** Ribbon caption. */
  label: string;
  /** Menu text when it differs from the ribbon caption. */
  menu?: string;
  tip: string;
  icon: IconName;
  /** Tauri accelerator (native menu) — also matched by the JS key handler. */
  accel?: string;
  /** Extra keys handled in JS only (not shown in menus), e.g. "Delete". */
  keys?: string[];
  /** Ribbon tab the button lives on. */
  tab?: RibbonTabName;
  run: () => unknown;
  enabled?: (s: AppState) => boolean;
  active?: (s: AppState) => boolean;
  /** Not built yet: the GOALS.md item that will deliver it. */
  soon?: string;
  /** Inside a text field, run this editing command instead (undo, select all…). */
  textFallback?: string;
  /** Drop-down choices shown under the ribbon button (Shape, Stamp…). */
  choices?: () => { label: string; run: () => void; active?: boolean }[];
  /** Colour swatch button (Fore / Back). */
  swatch?: "fore" | "back" | "ann";
}

export const STAMPS = ["Approved", "Not Approved", "Draft", "Final", "Confidential", "Paid", "Sold", "Received", "Rejected", "Void", "Urgent", "For Comment"];

const toolCmd = (tool: Tool) => () => store.setTool(tool);
const isTool = (tool: Tool) => (s: AppState) => s.tool === tool;
const shapeChoices = (prefix: "" | "shape-") => () => {
  const s = getState();
  const items: [string, Tool][] = [
    ["Rectangle", (prefix ? "shape-rect" : "rect") as Tool],
    ["Oval", (prefix ? "shape-oval" : "oval") as Tool],
    ["Line", (prefix ? "shape-line" : "line") as Tool],
    ["Arrow", (prefix ? "shape-arrow" : "arrow") as Tool],
  ];
  return items.map(([label, t]) => ({ label, active: s.tool === t, run: () => store.setTool(t) }));
};
/** A stamp's printed text: in the interface language, except Chinese (stamps use standard PDF fonts). */
const stampText = (label: string) => (language() === "zh" ? label : tr(label));

const stampChoices = () => {
  const s = getState();
  return [
    ...STAMPS.map((label) => ({
      label,
      active: s.tool === "stamp" && s.stampLabel === stampText(label),
      run: () => {
        store.setStampLabel(stampText(label));
        if (getState().tool !== "stamp") store.setTool("stamp");
        store.notify(tr("Stamp “{0}”: click or drag on the page", stampText(label)));
      },
    })),
    {
      label: "Custom…",
      run: () => {
        const t = window.prompt(tr("Stamp text"), getState().stampLabel);
        if (t && t.trim()) {
          store.setStampLabel(t.trim());
          if (getState().tool !== "stamp") store.setTool("stamp");
        }
      },
    },
  ];
};

const hasDoc = (s: AppState) => !!s.doc && !s.doc.passwordRequired;
const PDF = [{ name: "PDF", extensions: ["pdf"] }];

function stem(): string {
  const d = getState().doc;
  return docName(d).replace(/\.pdf$/i, "") || "document";
}

function dirOf(): string {
  const d = getState().doc;
  if (!d || isUntitled(d)) return "";
  const i = d.path.lastIndexOf("/");
  return i > 0 ? d.path.slice(0, i + 1) : "";
}

/** Ask for a target file, then write `bytes` there. */
async function exportBytes(ext: string, label: string, make: () => Promise<Uint8Array>) {
  const s = getState();
  if (!s.session) return;
  const target = await saveDialog({ defaultPath: `${dirOf()}${stem()}.${ext}`, filters: [{ name: label, extensions: [ext] }] });
  if (typeof target !== "string") return;
  try {
    const bytes = await make();
    const res = await cmdWriteFile(target, exp.toBase64(bytes));
    store.notify(tr("Exported {0} → {1}", label, res.published_path));
  } catch (e) {
    store.notify(tr("Export failed: {0}", (e as Error).message ?? e));
  }
}

const lines = () => exp.pageLines(getState().session!);

async function checkForUpdates() {
  store.notify(tr("Checking GitHub for a newer version…"));
  try {
    const u = await cmdCheckUpdate();
    if (!u.newer) {
      store.notify(tr("Stitchup {0} is the newest version", u.current));
      return;
    }
    let open = false;
    try {
      open = await ask(tr("Stitchup {0} is available (you have {1}). Open the download page?", u.latest, u.current), {
        title: tr("Update available"),
        okLabel: tr("Open Download Page"),
        cancelLabel: tr("Later"),
      });
    } catch {
      open = window.confirm(tr("Stitchup {0} is available (you have {1}). Open the download page?", u.latest, u.current));
    }
    if (open) await cmdOpenUrl(u.url);
  } catch (e) {
    store.notify(tr("Could not check for updates: {0}", (e as { message?: string }).message ?? String(e)));
  }
}

function compress() {
  store.setDialog("compress");
}

async function combineNew() {
  const chosen = await openDialog({ multiple: true, filters: PDF });
  const list = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
  if (list.length) await store.combine(list);
}

async function save() {
  const s = getState();
  if (isUntitled(s.doc)) await saveAs();
  else await store.save();
}

async function autoCrop() {
  const s = getState();
  if (!s.session) return;
  const boxes: number[][] = [];
  for (const p of store.targets()) {
    const b = await exp.inkBox(s.session, p);
    if (b) boxes.push([p, ...b]);
  }
  if (boxes.length) await store.crop(boxes);
  else store.notify(tr("Nothing to crop: the page is blank"));
}

/** Pick an image, decode it (JPEG kept as-is), then arm the Image tool. */
async function insertImage() {
  const p = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tif", "tiff"] }] });
  if (typeof p !== "string") return;
  try {
    const { b64 } = await cmdReadImage(p);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const name = p.split("/").pop() ?? "image";
    const bmp = await createImageBitmap(new Blob([bytes]));
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (isJpeg) {
      store.armImage({ format: "jpeg", b64, width: bmp.width, height: bmp.height, name });
      return;
    }
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    store.armImage({ format: "rgba", b64: exp.toBase64(new Uint8Array(px.buffer)), width: c.width, height: c.height, name });
  } catch (e) {
    store.notify(tr("Could not read that image: {0}", (e as Error).message ?? e));
  }
}

const zoomStep = (dir: 1 | -1) => {
  const z = getState().zoom;
  store.setZoom(Math.min(5, Math.max(0.25, Math.round((dir > 0 ? z * 1.1 : z / 1.1) * 100) / 100)), "custom");
};

export const COMMANDS: Command[] = [
  // ---------------------------------------------------------------- Document
  { id: "new", label: "New", menu: "New…", tip: "Create a new empty document (⌘N)", icon: "new", accel: "CmdOrCtrl+N", tab: "Document", run: () => store.setDialog("new") },
  { id: "open", label: "Open", menu: "Open…", tip: "Open an existing PDF file (⌘O)", icon: "open", accel: "CmdOrCtrl+O", tab: "Document", run: pickAndOpen },
  { id: "save", label: "Save", tip: "Save changes to the current file (⌘S)", icon: "save", accel: "CmdOrCtrl+S", tab: "Document", run: save, enabled: hasDoc },
  { id: "saveAs", label: "Save As", menu: "Save As…", tip: "Save to a new file name (⌘⇧S)", icon: "save-as", accel: "CmdOrCtrl+Shift+S", tab: "Document", run: saveAs, enabled: hasDoc },
  { id: "properties", label: "Properties", menu: "Document Properties…", tip: "Edit the document metadata (title, author, subject, keywords)", icon: "info", tab: "Document", run: () => store.setMetadataOpen(true), enabled: hasDoc },
  { id: "import", label: "Import", menu: "Insert Pages from PDF…", tip: "Add the pages of one or more other PDFs at the end of this document", icon: "import", tab: "Document", run: async () => {
      const chosen = await openDialog({ multiple: true, filters: PDF });
      const list = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
      for (const p of list) if (!(await store.importPdf(p))) break;
    }, enabled: hasDoc },
  { id: "exportText", label: "Export Text", menu: "Text…", tip: "Write the document text out to a .txt file", icon: "export-text", tab: "Document", enabled: hasDoc, run: () => exportBytes("txt", "Text", async () => exp.toText(await lines())) },
  { id: "exportCsv", label: "Export CSV", menu: "CSV…", tip: "Write page data out to a .csv file", icon: "csv", tab: "Document", enabled: hasDoc, run: () => exportBytes("csv", "CSV", async () => exp.toCsv(getState().session!, await lines())) },
  { id: "exportImages", label: "Images", menu: "Images (JPG / PNG)…", tip: "Export each page as a JPG or PNG image", icon: "image", tab: "Document", enabled: hasDoc, run: () => store.setDialog("exportImages") },
  { id: "exportRtf", label: "RTF", menu: "RTF…", tip: "Write the document text out to an RTF file", icon: "rtf", tab: "Document", enabled: hasDoc, run: () => exportBytes("rtf", "RTF", async () => exp.toRtf(await lines())) },
  { id: "exportDocx", label: "DOCX", menu: "DOCX…", tip: "Write the document text out to a Word .docx file", icon: "docx", tab: "Document", enabled: hasDoc, run: () => exportBytes("docx", "Word document", async () => exp.toDocx(await lines())) },
  { id: "exportOdt", label: "ODT", menu: "ODT…", tip: "Write the document text out to an OpenDocument .odt file", icon: "odt", tab: "Document", enabled: hasDoc, run: () => exportBytes("odt", "OpenDocument text", async () => exp.toOdt(await lines())) },
  { id: "print", label: "Print", menu: "Print…", tip: "Print the document, all pages or a page range (⌘P)", icon: "print", accel: "CmdOrCtrl+P", tab: "Document", enabled: hasDoc, run: () => store.setDialog("print") },
  { id: "combineNew", label: "Combine", menu: "Combine into New…", tip: "Combine several PDFs into a new document", icon: "merge", run: combineNew },
  { id: "compress", label: "Compress", menu: "Compress PDF…", tip: "Save a smaller copy: unused data removed, streams compressed, large images downsampled", icon: "compress", enabled: hasDoc, run: compress },
  { id: "settings", label: "Settings", menu: "Settings…", tip: "Crash recovery, opening zoom, sidebar (⌘,)", icon: "info", accel: "CmdOrCtrl+,", run: () => store.setDialog("settings") },
  { id: "newTab", label: "New Tab", tip: "Open an empty tab (⌘T)", icon: "new", accel: "CmdOrCtrl+T", run: () => store.newTab() },
  { id: "closeTab", label: "Close Tab", tip: "Close this tab (⌘W)", icon: "exit", accel: "CmdOrCtrl+W", run: () => store.closeTab(getState().activeTab) },
  { id: "nextTab", label: "Next Tab", tip: "Next tab (⌃Tab)", icon: "next", accel: "Ctrl+Tab", enabled: (s) => s.tabs.length > 1, run: () => store.cycleTab(1) },
  { id: "prevTab", label: "Previous Tab", tip: "Previous tab (⌃⇧Tab)", icon: "prev", accel: "Ctrl+Shift+Tab", enabled: (s) => s.tabs.length > 1, run: () => store.cycleTab(-1) },
  { id: "exit", label: "Exit", menu: "Quit Stitchup", tip: "Quit (⌘Q)", icon: "exit", accel: "CmdOrCtrl+Q", run: () => store.exitApp() },

  // ------------------------------------------------------------------- Pages
  { id: "rotateCcw", label: "Rotate CCW", menu: "Rotate Left", tip: "Rotate the current page(s) 90° counter-clockwise (⌘⇧R)", icon: "rotate-ccw", accel: "CmdOrCtrl+Shift+R", tab: "Pages", enabled: hasDoc, run: () => store.rotate(store.targets(), false) },
  { id: "rotateCw", label: "Rotate CW", menu: "Rotate Right", tip: "Rotate the current page(s) 90° clockwise (⌘R)", icon: "rotate-cw", accel: "CmdOrCtrl+R", tab: "Pages", enabled: hasDoc, run: () => store.rotate(store.targets(), true) },
  { id: "rotateAll", label: "Rotate All", menu: "Rotate All Pages Right", tip: "Rotate every page 90° clockwise", icon: "rotate-cw", enabled: hasDoc, run: () => store.rotate(getState().doc!.pages.map((p) => p.page_no), true) },
  { id: "delete", label: "Delete", menu: "Delete Page(s)", tip: "Delete the current page(s) (⌫)", icon: "trash", keys: ["Delete", "Backspace"], tab: "Pages",
    enabled: (s) => hasDoc(s) && (!!s.picked || (s.selection.length || 1) < (s.doc?.pages.length ?? 0)),
    // ⌫ with objects selected (Select tool) deletes those, not pages.
    run: () => (getState().picked ? store.deletePicked() : store.deletePages(store.targets())) },
  { id: "addPage", label: "Add Page", menu: "Add Page…", tip: "Add a blank page after the current page", icon: "insert-blank", tab: "Pages", enabled: hasDoc, run: () => store.setDialog("addPage") },
  { id: "extract", label: "Extract", menu: "Extract Selected Page(s)…", tip: "Save the selected page(s) as their own PDF file", icon: "extract", tab: "Pages", enabled: hasDoc, run: () => (getState().selection.length ? extractTo(store.targets()) : store.setDialog("extract")) },
  { id: "split", label: "Split", menu: "Split Document…", tip: "Split the document into several files", icon: "split", tab: "Pages", enabled: (s) => hasDoc(s) && (s.doc?.pages.length ?? 0) > 1, run: () => store.setDialog("split") },
  { id: "autoCrop", label: "Auto-Crop", menu: "Auto-Crop Selected Page(s)", tip: "Trim the white margin around the selected page(s)", icon: "crop", tab: "Pages", enabled: hasDoc, run: autoCrop },
  { id: "headerFooter", label: "Header/Footer", menu: "Header & Footer…", tip: "Add page numbers, “Page X of Y”, Bates numbers or any text at the top or bottom of the pages", icon: "text", tab: "Pages", enabled: hasDoc, run: () => store.setDialog("headerFooter") },
  { id: "selectAll", label: "Select All", menu: "Select All Pages", tip: "Select every page (⌘A)", icon: "thumbnails", accel: "CmdOrCtrl+A", enabled: hasDoc, run: () => store.selectAllPages(), textFallback: "selectAll" },

  // ---------------------------------------------------------------- Annotate
  { id: "annType", label: "Type Text", menu: "Type Text", tip: "Fill in forms that have no fields: click anywhere on the page and type (Enter places it, Esc cancels)", icon: "text", tab: "Annotate", enabled: hasDoc,
    active: isTool("typetext"),
    choices: () => [9, 11, 14, 18].map((pt) => ({
      label: tr(pt === 9 ? "Small ({0} pt)" : pt === 11 ? "Normal ({0} pt)" : pt === 14 ? "Large ({0} pt)" : "Extra large ({0} pt)", pt),
      active: getState().tool === "typetext" && getState().typeSize === pt,
      run: () => {
        store.setTypeSize(pt);
        if (getState().tool !== "typetext") store.setTool("typetext");
      },
    })), run: () => {} },
  { id: "annMark", label: "Marks", menu: "Check / Cross Mark", tip: "Tick a printed checkbox: ✓ or ✗ where you click", icon: "pen", tab: "Annotate", enabled: hasDoc,
    active: (s) => s.tool === "check" || s.tool === "cross",
    choices: () => [
      { label: tr("✓ Check mark"), active: getState().tool === "check", run: () => store.setTool("check") },
      { label: tr("✗ Cross"), active: getState().tool === "cross", run: () => store.setTool("cross") },
    ], run: () => {} },
  { id: "annHighlight", label: "Highlight", tip: "Drag across text to highlight it", icon: "highlight", tab: "Annotate", enabled: hasDoc, active: isTool("highlight"), run: toolCmd("highlight") },
  { id: "annUnderline", label: "Underline", tip: "Drag across text to underline it (Fore colour)", icon: "underline", tab: "Annotate", enabled: hasDoc, active: isTool("underline"), run: toolCmd("underline") },
  { id: "annStrike", label: "Strike", menu: "Strike-out", tip: "Drag across text to strike it out (Fore colour)", icon: "strike", tab: "Annotate", enabled: hasDoc, active: isTool("strikeout"), run: toolCmd("strikeout") },
  { id: "annNote", label: "Note", menu: "Sticky Note", tip: "Click to attach a sticky note comment", icon: "note", tab: "Annotate", enabled: hasDoc, active: isTool("note"), run: toolCmd("note") },
  { id: "annText", label: "Text Box", tip: "Drag a box, then type its text", icon: "textbox", tab: "Annotate", enabled: hasDoc, active: isTool("textbox"), run: toolCmd("textbox") },
  { id: "annShape", label: "Shape", tip: "Draw a rectangle, oval, line or arrow (Fore outline, Back fill)", icon: "shape", tab: "Annotate", enabled: hasDoc,
    active: (s) => ["rect", "oval", "line", "arrow"].includes(s.tool ?? ""), choices: shapeChoices(""), run: () => {} },
  { id: "annStamp", label: "Stamp", tip: "Choose a stamp, then click or drag on the page", icon: "stamp", tab: "Annotate", enabled: hasDoc, active: isTool("stamp"), choices: stampChoices, run: () => {} },
  { id: "annLink", label: "Link", menu: "Link…", tip: "Drag the clickable area, then give a web address or page number", icon: "link", tab: "Annotate", enabled: hasDoc, active: isTool("link"), run: toolCmd("link") },
  { id: "annPen", label: "Pen", tip: "Draw freehand lines on the page (Fore colour)", icon: "pen", tab: "Annotate", enabled: hasDoc, active: isTool("pen"), run: toolCmd("pen") },
  { id: "annFore", label: "Colour", menu: "Annotation Colour…", tip: "Colour for new annotations: highlight, underline, strike-out, pen, shapes and text boxes", icon: "palette", tab: "Annotate", swatch: "ann", run: () => {} },
  { id: "back", label: "Fill", menu: "Fill Colour…", tip: "Fill colour for new rectangles and ovals (or no fill)", icon: "palette", tab: "Annotate", swatch: "back", run: () => {} },

  // ----------------------------------------------------------------- Content
  { id: "select", label: "Select", menu: "Select / Move Content Object", tip: "Click text, images or annotations to select (⌘-click adds, drag a box for many); drag to move; ⌫ deletes", icon: "select", tab: "Content", enabled: hasDoc, active: isTool("select"), run: toolCmd("select") },
  { id: "editText", label: "Edit Text", menu: "Edit Text", tip: "Click any line of text to edit it in place, in its own font (or just double-click a line)", icon: "text", tab: "Content", enabled: hasDoc, active: (s) => s.editMode, run: () => {
      const on = getState().editMode;
      store.setTool(null); // (also leaves Edit Text mode)
      store.setEditMode(!on);
    } },
  { id: "objDelete", label: "Delete", menu: "Delete Selected Object", tip: "Remove the selected objects (⌫)", icon: "trash", tab: "Content",
    enabled: (s) => hasDoc(s) && !!s.picked && s.picked.objects.length + s.picked.annots.length > 0, run: () => store.deletePicked() },
  { id: "font", label: "Font", menu: "Font and Size…", tip: "Change the font family and size of the selected text or the line being edited", icon: "font", tab: "Content",
    enabled: (s) => hasDoc(s) && (!!s.picked?.objects.length || !!s.editingLine), run: () => store.setDialog("font") },
  { id: "fore", label: "Colour", menu: "Text Colour…", tip: "Recolour the selected text, shapes or annotations, or the line being edited", icon: "palette", tab: "Content", swatch: "fore", run: () => {} },
  { id: "image", label: "Image", menu: "Insert Image…", tip: "Insert a picture (PNG, JPEG, GIF, WebP, HEIC…): choose it, then click or drag on the page", icon: "image", tab: "Content", enabled: hasDoc, active: isTool("image"), run: insertImage },
  { id: "ocr", label: "OCR", menu: "Recognize Text (OCR)", tip: "Make scanned pages searchable: recognise their text on this computer (Apple Vision on macOS) and add it as an invisible layer", icon: "find", tab: "Content", enabled: (st) => hasDoc(st) && st.platform.ocr,
    choices: () => [
      { label: "Pages Without Text", run: () => void store.recognizeText("untexted") },
      { label: "This Page", run: () => void store.recognizeText("current") },
      { label: "All Pages", run: () => void store.recognizeText("all") },
    ], run: () => {} },

  // -------------------------------------------------------------------- Zoom
  { id: "zoomOut", label: "Zoom -", menu: "Zoom Out", tip: "Zoom out one step (⌘−)", icon: "zoom-out", accel: "CmdOrCtrl+-", tab: "Zoom", enabled: hasDoc, run: () => zoomStep(-1) },
  { id: "zoomIn", label: "Zoom +", menu: "Zoom In", tip: "Zoom in one step (⌘=)", icon: "zoom-in", accel: "CmdOrCtrl+=", tab: "Zoom", enabled: hasDoc, run: () => zoomStep(1) },
  { id: "zoom100", label: "100%", tip: "Reset the zoom to 100% (⌘1)", icon: "actual", accel: "CmdOrCtrl+1", tab: "Zoom", enabled: hasDoc, active: (s) => s.zoomMode === "actual", run: () => store.setZoom(1, "actual") },
  { id: "fitWidth", label: "Fit Width", tip: "Scale the page so its width fills the window (⌘2)", icon: "fit-width", accel: "CmdOrCtrl+2", tab: "Zoom", enabled: hasDoc, active: (s) => s.zoomMode === "fit-width", run: () => store.setFitMode("fit-width") },
  { id: "fitPage", label: "Fit Page", tip: "Scale the page so the whole page is visible (⌘0)", icon: "fit-page", accel: "CmdOrCtrl+0", tab: "Zoom", enabled: hasDoc, active: (s) => s.zoomMode === "fit-page", run: () => store.setFitMode("fit-page") },

  // ---------------------------------------------------------------- Navigate
  { id: "prev", label: "Previous", menu: "Previous Page", tip: "Go to the previous page (⌘↑ / PgUp)", icon: "prev", accel: "CmdOrCtrl+Up", keys: ["PageUp"], tab: "Navigate", enabled: (s) => hasDoc(s) && s.currentPage > 1, run: () => store.goToPage(getState().currentPage - 1) },
  { id: "next", label: "Next", menu: "Next Page", tip: "Go to the next page (⌘↓ / PgDn)", icon: "next", accel: "CmdOrCtrl+Down", keys: ["PageDown"], tab: "Navigate", enabled: (s) => hasDoc(s) && s.currentPage < (s.doc?.pages.length ?? 0), run: () => store.goToPage(getState().currentPage + 1) },
  { id: "spread", label: "Spread", menu: "Two-Page Spread", tip: "Show facing pages side by side (F5)", icon: "spread", accel: "F5", tab: "Navigate", enabled: hasDoc, active: (s) => s.viewMode === "spread", run: () => store.setViewMode(getState().viewMode === "spread" ? "continuous" : "spread") },
  { id: "single", label: "Single", menu: "Single Page", tip: "One page at a time", icon: "single", tab: "Navigate", enabled: hasDoc, active: (s) => s.viewMode === "single", run: () => store.setViewMode("single") },
  { id: "continuous", label: "Continuous", menu: "Continuous Scroll", tip: "All pages in one scrolling column", icon: "continuous", tab: "Navigate", enabled: hasDoc, active: (s) => s.viewMode === "continuous", run: () => store.setViewMode("continuous") },
  { id: "sidebar", label: "Sidebar", tip: "Show or hide the page thumbnails (F8)", icon: "sidebar", accel: "F8", tab: "Navigate", active: (s) => s.paneOpen, run: () => store.setPaneOpen(!getState().paneOpen) },

  // ---------------------------------------------------------------- Security
  { id: "encrypt", label: "Encrypt", menu: "Save As Encrypted…", tip: "Save a copy protected by a password (AES-256)", icon: "lock", tab: "Security", enabled: hasDoc, run: () => store.setDialog("encrypt") },
  { id: "sign", label: "Sign", menu: "Sign Document…", tip: "Add a digital signature and save a signed copy", icon: "sign", tab: "Security", enabled: hasDoc, active: isTool("sign"), run: () => store.setDialog("sign") },
  { id: "quickSign", label: "QuickSign", menu: "QuickSign", tip: "Place your handwritten signature (from a JPG, GIF or PNG); keep it for next time, optionally locked with a password", icon: "pen", tab: "Security", enabled: hasDoc,
    choices: () => [
      ...getState().signatures.map((g) => ({ label: `${g.protected ? "🔒 " : ""}${g.name}`, run: () => void store.useSignature(g) })),
      { label: "Create New Signature…", run: () => store.setDialog("quickSignNew") },
      ...(getState().signatures.length ? [{ label: "Manage Signatures…", run: () => store.setDialog("quickSignManage") }] : []),
    ], run: () => {} },
  { id: "annRedact", label: "Redact", tip: "Drag over content to permanently remove it and black it out", icon: "redact", tab: "Security", enabled: hasDoc, active: isTool("redact"), run: toolCmd("redact") },
  { id: "watermark", label: "Watermark", menu: "Watermark…", tip: "Stamp a text watermark across every page", icon: "watermark", tab: "Security", enabled: hasDoc, run: () => store.setDialog("watermark") },

  // -------------------------------------------------------------- Edit / misc
  { id: "undo", label: "Undo", tip: "Undo the last change (⌘Z)", icon: "undo", accel: "CmdOrCtrl+Z", enabled: (s) => hasDoc(s) && (s.doc?.history.length ?? 0) > 0, run: () => store.undo(), textFallback: "undo" },
  { id: "redo", label: "Redo", tip: "Redo (⌘⇧Z / ⌘Y)", icon: "redo", accel: "CmdOrCtrl+Shift+Z", keys: ["Meta+y", "Control+y"], enabled: (s) => hasDoc(s) && (s.doc?.redo.length ?? 0) > 0, run: () => store.redo(), textFallback: "redo" },
  { id: "find", label: "Find", menu: "Find…", tip: "Search the document text (⌘F)", icon: "find", accel: "CmdOrCtrl+F", enabled: hasDoc, run: () => {
      const el = document.querySelector<HTMLInputElement>(".search-box input");
      el?.focus();
      el?.select();
    } },
  { id: "findNext", label: "Find Next", tip: "Next match (F3 / ⌘G)", icon: "next", accel: "F3", keys: ["Meta+g"], enabled: hasDoc, run: () => store.findNext(1) },
  { id: "findPrev", label: "Find Previous", tip: "Previous match (⇧F3 / ⌘⇧G)", icon: "prev", accel: "Shift+F3", keys: ["Meta+Shift+g"], enabled: hasDoc, run: () => store.findNext(-1) },
  { id: "copy", label: "Copy", tip: "Copy the selected text (⌘C)", icon: "copy", enabled: (s) => s.selectionText.length > 0, run: () => store.copySelection() },
  { id: "darkMode", label: "Dark Mode", tip: "Flip between Light Grey and Dark Blue (⌘D)", icon: "palette", accel: "CmdOrCtrl+D", run: () => toggleDark() },
  { id: "guide", label: "User Guide", tip: "How to use Stitchup (F1)", icon: "info", accel: "F1", run: () => store.setDialog("help") },
  { id: "checkUpdate", label: "Check for Updates", menu: "Check for Updates…", tip: "Ask GitHub whether a newer Stitchup is available (nothing is downloaded or installed)", icon: "info", run: checkForUpdates },
  { id: "about", label: "About", menu: "About Stitchup", tip: "Version and open-source licenses", icon: "info", run: () => store.setDialog("about") },
];

export const byId = new Map(COMMANDS.map((c) => [c.id, c]));

/** Run a command by id, honouring `enabled` and text-field fallbacks. */
export async function runCommand(id: string): Promise<void> {
  const c = byId.get(id);
  if (!c) return;
  const ae = document.activeElement as HTMLElement | null;
  const typing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
  if (typing && c.textFallback) {
    document.execCommand(c.textFallback);
    return;
  }
  const s = getState();
  if (c.soon) {
    store.notify(tr("{0} is coming soon (goal {1} in GOALS.md)", c.label, c.soon));
    return;
  }
  if (c.enabled && !c.enabled(s)) {
    if (!s.doc) store.notify(tr("Open a document first"));
    return;
  }
  if (c.choices || c.swatch) {
    // From the menu bar / shortcuts: show the ribbon tab, then open the
    // button's drop-down / palette once that tab's buttons are on screen.
    const switching = !!c.tab && s.ribbonTab !== c.tab;
    if (c.tab) store.setRibbonTab(c.tab);
    const open = () => window.dispatchEvent(c.choices ? new CustomEvent("stitchup-choices", { detail: c.id }) : new CustomEvent("stitchup-swatch", { detail: c.swatch }));
    if (switching) setTimeout(open, 50);
    else open();
    return;
  }
  await c.run();
}

/** Does a keyboard event match a Tauri accelerator / key string? */
export function matchesKey(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split("+");
  const key = parts.pop()!;
  const want = {
    cmd: parts.some((p) => p === "CmdOrCtrl" || p === "Meta" || p === "Control" || p === "Ctrl" || p === "Cmd"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
  if ((e.metaKey || e.ctrlKey) !== want.cmd || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const k = e.key;
  if (key === "=") return k === "=" || k === "+";
  if (key === "-") return k === "-" || k === "_";
  if (key === ",") return k === ",";
  if (key === "Up") return k === "ArrowUp";
  if (key === "Down") return k === "ArrowDown";
  return k.toLowerCase() === key.toLowerCase();
}

/** Menu bar layout (same menus as the Windows build). */
export const MENUS: { title: string; items: (string | "-" | { submenu: string })[] }[] = [
  // macOS conventions + Nitro's grouping: About / Settings / Quit live in the
  // app menu, Export is a File submenu, tab switching is in Window, every
  // page command is in Pages and every protection tool in Security.
  { title: "File", items: ["new", "open", { submenu: "recent" }, "-", "newTab", "closeTab", "-", "save", "saveAs", { submenu: "export" }, "-", "combineNew", "compress", "properties", "-", "print"] },
  { title: "Edit", items: ["undo", "redo", "-", { submenu: "clipboard" }, "-", "find", "findNext", "findPrev", "-", "select", "editText", "objDelete", "fore", "font", "image", "ocr"] },
  { title: "Pages", items: ["import", "addPage", "delete", "-", "rotateCw", "rotateCcw", "rotateAll", "-", "extract", "split", "autoCrop", "headerFooter", "-", "selectAll"] },
  { title: "Annotate", items: ["annType", "annMark", "-", "annHighlight", "annUnderline", "annStrike", "annNote", "annText", "annShape", "annStamp", "annLink", "annPen", "-", "annFore", "back"] },
  { title: "Security", items: ["encrypt", "sign", "quickSign", "annRedact", "watermark"] },
  { title: "View", items: ["zoomIn", "zoomOut", "zoom100", "fitWidth", "fitPage", "-", "prev", "next", "-", "spread", "single", "continuous", "sidebar", "-", { submenu: "ribbonTabs" }, { submenu: "schemes" }] },
  { title: "Help", items: ["guide", "checkUpdate"] },
];
