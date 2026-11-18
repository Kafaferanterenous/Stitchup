# Stitchup (macOS) — goals

Target: the best all-round PDF editor, at feature and look parity with the
Windows build (github.com/Kafaferanterenous/stitchup-Win v0.12.28), and ahead of it where macOS allows.
Updated 2026-11-17 (v0.15.0). Status key: ✅ done · 🔨 in progress · ⬜ to do. Every ✅ item is covered by an automated test.

## A. Look & navigation (same as Windows)
| # | Goal | Status |
|---|------|--------|
| A1 | Ribbon tabs Document · Pages · Annotate · Content · Zoom · Navigate · Security, Windows button set/labels/tooltips | ✅ |
| A2 | Menu bar File · Export · Edit · Pages · Annotate · View · Tabs · Help (native macOS menu, same items/shortcuts) | ✅ |
| A3 | The 9 Windows colour schemes (Light Grey default … Pastel 3), remembered | ✅ |
| A4 | Windows status bar (file name + `*` when unsaved, page x of y, selection count, zoom); red Save when dirty | ✅ |
| A5 | Drag & drop a PDF onto the window to open; open from Finder / command line — built; drag-drop needs a check on your Mac (not testable headless) | 🔨 |
| A6 | Multi-document tabs (⌘T, ⌘W, ⌃Tab / ⌃⇧Tab), each with its own page, zoom and undo; opening an open file switches to its tab; closing an unsaved tab asks | ✅ |

## A2. Ribbon & menus tidy-up (v0.11.0)
Duplicates removed, Nitro / macOS layout: Print Preview and Print to PDF folded into Print (preview inside, Save as PDF in the macOS panel); Merge PDFs / Merge PDF folded into Import (several files); Security ▸ Stamp (= Annotate ▸ Stamp), Content ▸ Shapes (= Annotate ▸ Shape) and Content ▸ Recolor (= Content ▸ Colour) removed; Back colour → Annotate ▸ Fill; Redact → Security (Nitro: Protect). Menus: About / Settings only in the app menu, Export as a File submenu, page commands all in Pages, new Security menu, tab switching in Window, ribbon-tab switcher in View.

## B. Document
| # | Goal | Status |
|---|------|--------|
| B1 | New blank document | ✅ |
| B2 | Save in place (atomic) + Save As | ✅ |
| B3 | Import / Merge PDFs; Combine into New — Import, Merge PDFs, Combine into New | ✅ |
| B4 | Export Text / CSV / Images (PNG, JPG) / RTF / DOCX / ODT | ✅ |
| B5 | Print, Print Preview, Print to PDF — preview dialog + macOS print panel (Save as PDF there); the print panel gets the chosen paper, orientation and no margins, one printed page per selected page (v0.6.1 fix for "1 of 2"); not yet tried on a real printer | ✅ |
| B6 | Document Properties ✅ · Attachments button removed for now (v0.6.1, user request); the code is kept | ✅ |
| B7 | Compress PDF — unused objects removed, streams/object streams compressed; images downsampled to 150 / 300 / 96 dpi from their size on the page (JPEG stays JPEG, lossless stays lossless, soft masks resampled too) | ✅ |
| B8 | Crash-recovery snapshots (Off / 30 s / 1 min / 5 min, off by default like Windows) offered back after a crash; Settings (⌘,); quitting or closing the window with unsaved changes asks | ✅ |
| B9 | Built-in User Guide (F1) — in-app guide (F1) rather than a help.pdf | ✅ |

## C. Pages
| # | Goal | Status |
|---|------|--------|
| C1 | Rotate / delete / add / reorder / multi-select | ✅ |
| C2 | Extract / Split | ✅ |
| C3 | Auto-Crop | ✅ |
| C4 | Move pages between open tabs (drag a thumbnail onto a tab, or right-click ▸ Move Page to …) | ✅ |

## D. Annotate
| # | Goal | Status |
|---|------|--------|
| D1 | Highlight, Underline, Strike-out (drag to draw) | ✅ |
| D2 | Sticky Note, Text Box | ✅ |
| D3 | Shapes (rectangle, oval, line, arrow), Pen (freehand ink) | ✅ |
| D4 | Stamps (Draft, Approved, Paid…), Links (web + page) and link activation — stamps (12 + custom), web links and page links; clicking a link follows it | ✅ |
| D5 | Select / move / delete / recolour annotations (appearance redrawn in the new colour) | ✅ |

## E. Content editing
| # | Goal | Status |
|---|------|--------|
| E1 | In-place text edit in the original font | ✅ |
| E2 | Unicode fallback font — Central European Latin via standard fonts; Cyrillic, Greek, CJK and any other script via an installed font of the same style (subset-embedded, ToUnicode kept); Arabic, Hebrew, Indic, Thai shaped (rustybuzz: joining, ligatures, conjuncts, mark positioning) in bidi visual order, with /ActualText for copy | ✅ |
| E3 | Select / move / delete content objects (text, images, paths), marquee select — text runs, images and vector shapes (lines, rectangles, filled areas — also inside grouped drawings / form XObjects nested up to 16 deep, edited copy-on-write; text inside groups too, including in-place editing; recolour with Fore); move, delete, marquee, ⌘-click | ✅ |
| E4 | Recolor, Font & size, Fore/Back colours — colour palettes; while editing a line a bar shows its real font and size; any installed font (searchable picker, names in their own typeface, subset-embedded) or the standard ones; bold/italic also on the original font (same installed family, else nearest standard) | ✅ |
| E5 | Insert image — PNG (with transparency), JPEG (embedded as-is), GIF/WebP/HEIC/TIFF | ✅ |

## F. Security & forms
| # | Goal | Status |
|---|------|--------|
| F1 | Open password-protected PDFs | ✅ |
| F2 | Encrypt (AES-256 — stronger than the Windows RC4) | ✅ |
| F3 | Watermark | ✅ |
| F4 | True redaction (content removed, not covered) — text glyphs and whole images under the box removed; partly-covered images are blacked out | ✅ |
| F5 | Fill AcroForms — text, multi-line, checkbox, radio, drop-down; appearances regenerated (shows in Preview/Acrobat); undoable | ✅ |
| F6 | Digital signature — self-signed RSA-2048 / SHA-256 PKCS#7, visible box (any script: installed fonts with per-character fallback, long lines narrowed to fit); verified with OpenSSL. Signing or saving (⌘S) an already-signed PDF — edited or not — appends an incremental update, so every earlier signature stays valid (three signatures verified with OpenSSL) | ✅ |
| F7 | QuickSign (Nitro-style handwritten signature): from JPG / GIF / PNG or drawn with mouse / trackpad / pen (smoothed, speed-sensitive width, black or blue ink), trimmed, white made transparent; optionally kept, optionally password-locked (AES-256-GCM, PBKDF2 600 000 rounds, file 0600); unlock on use; manage / delete (locked ones need the password) | ✅ |

## G. Beyond Windows (macOS)
| # | Goal | Status |
|---|------|--------|
| G1 | OCR with Apple Vision, on-device (Content ▸ OCR: pages without text / this page / all) → invisible text layer, so scans become searchable and copyable; one undo step | ✅ |
| G2 | Find with F3 / ⇧F3, highlight all ✅ | ✅ |

## H. Other platforms
| # | Goal | Status |
|---|------|--------|
| H1 | Windows (NSIS / MSI) and Linux (deb / AppImage) builds from the same code base via GitHub Actions; engine tests pass on both; per-OS fonts, crash recovery, menus, shortcut hints, OCR availability. Awaiting tests on real machines | 🔨 |
| H2 | OCR on Windows (Windows.Media.Ocr) and Linux (Tesseract) | ⬜ |
| H3 | Interface languages: English, Polish, Italian, German, French, Chinese (Simplified) — 582 strings, Settings ▸ Language, system language on first start, native menus rebuilt on change; stamps printed in the chosen language (not Chinese: standard PDF fonts) | ✅ |
| H4 | "Experimental — use at your own risk" notice: first start (once), About, README, release notes | ✅ |
| H5 | Header & Footer (Pages tab): six positions, page numbers, "Page X of Y", Bates (prefix + digits), {date}, {file}, font / size / margin / start number / page range; oriented to rotated pages; undoable | ✅ |
| H6 | File ▸ Open Recent + recent files on the start screen; tabs shrink with many documents and keep the active one in view | ✅ |
| H7 | Help ▸ Check for Updates (GitHub releases; only when asked, nothing downloaded) | ✅ |
| H8 | Polish: typesetting (półpauza, non-breaking space after one-letter words), old-literary tone in About / notices / guide; About icon shows a Kabaret Dudek line and plays the user's own sound file (none shipped) | ✅ |
| H9 | Slow / large PDFs: "Keep your pants on, mate — it's loadin'…" card with spinner, file name and seconds while opening | ✅ |
| H10 | Type Text (click anywhere, type; 9–18 pt) and ✓ / ✗ marks, for forms without real fields — like Nitro's Type Text / Acrobat Fill & Sign | ✅ |
| H11 | Underline selected lines (⌘U); proper plural forms (Polish 1/2–4/5+); ~30 more strings translated | ✅ |
| H12 | Form creation: Forms tab — text, multi-line, check box, radio group, drop-down, signature fields; Edit Fields (move, properties, required / read-only, delete); undoable; read by pdf-lib | ✅ |
| H13 | Detect Fields: find boxes, blank lines, check boxes and circles on flat forms (rendered-page scan), name them from nearby labels, group radio rows; click to leave out, add all in one undo step | ✅ |
| H14 | Resize form fields by dragging handles (Edit Fields), appearance redrawn at the new size; Ctrl / ⌘ + mouse wheel (and trackpad pinch) zooms around the pointer | ✅ |
