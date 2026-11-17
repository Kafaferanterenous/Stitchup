//! QuickSign dialogs: create a signature from an image, unlock a
//! password-protected one, and manage the saved ones.

import { useRef, useState } from "react";
import { INKS, SignaturePad, type SignaturePadHandle } from "./SignaturePad";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { store, useAppState } from "../../store";
import { cmdQuickSignDelete, cmdQuickSignLoad, cmdQuickSignSave, cmdReadImage, type SavedSignature } from "../../ipc";
import { prepareSignature, signatureFromPng, type PreparedSignature } from "../../quicksign";

const close = () => store.setDialog(null);
const errText = (e: unknown) => (e as { message?: string }).message ?? String(e);

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** QuickSign ▸ Create New Signature: from a JPG, GIF or PNG file, or drawn. */
export function QuickSignNewDialog() {
  const [mode, setMode] = useState<"file" | "draw">("file");
  const pad = useRef<SignaturePadHandle | null>(null);
  const [ink, setInk] = useState(INKS[1].color);
  const [drawn, setDrawn] = useState(false);
  const [file, setFile] = useState<{ b64: string; name: string } | null>(null);
  const [sigFile, setSig] = useState<PreparedSignature | null>(null);
  const [removeWhite, setRemoveWhite] = useState(true);
  const [name, setName] = useState("My signature");
  const [keep, setKeep] = useState(true);
  const [lock, setLock] = useState(false);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function prepare(b64: string, white: boolean) {
    try {
      setSig(await prepareSignature(b64, white));
      setError(null);
    } catch (e) {
      setSig(null);
      setError(errText(e));
    }
  }

  async function choose() {
    const p = await openDialog({ multiple: false, filters: [{ name: "Signature image", extensions: ["png", "jpg", "jpeg", "gif"] }] });
    if (typeof p !== "string") return;
    try {
      const { b64 } = await cmdReadImage(p);
      const fname = p.split("/").pop() ?? "signature";
      setFile({ b64, name: fname });
      if (name === "My signature" || !name.trim()) setName(fname.replace(/\.[^.]+$/, ""));
      await prepare(b64, removeWhite);
    } catch (e) {
      setError(`Could not read that image: ${errText(e)}`);
    }
  }

  const pwProblem = keep && lock ? (pw1.length < 4 ? "Use a password of at least 4 characters" : pw1 !== pw2 ? "The passwords don't match" : null) : null;

  async function place() {
    if (pwProblem) return;
    setBusy(true);
    try {
      let sig = mode === "file" ? sigFile : null;
      if (mode === "draw") {
        const png = await pad.current?.png();
        if (!png) throw new Error("draw your signature first");
        sig = await prepareSignature(png, false);
      }
      if (!sig) return;
      let note: string | undefined;
      if (keep) {
        await cmdQuickSignSave(name, sig.png, lock ? pw1 : undefined);
        await store.loadSignatures();
        note = lock ? `Signature “${name}” saved, locked with a password` : `Signature “${name}” saved for next time`;
      }
      close();
      store.placeSignature(sig, name, note);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create New Signature" onClose={close}>
      <div className="qs-modes" role="tablist" aria-label="Signature source">
        <button role="tab" aria-selected={mode === "file"} className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>
          From File
        </button>
        <button role="tab" aria-selected={mode === "draw"} className={mode === "draw" ? "on" : ""} onClick={() => setMode("draw")}>
          Draw
        </button>
      </div>
      {mode === "file" ? (
        <>
          <p className="muted">Choose a photo or scan of your handwritten signature (JPG, GIF or PNG). Sign on white paper with a dark pen for the best result.</p>
          <div className="qs-pick">
            <button onClick={() => void choose()}>{file ? "Choose Another Image…" : "Choose Image…"}</button>
            <span className="muted">{file?.name ?? "No image chosen"}</span>
          </div>
          <div className="qs-preview" aria-label="Signature preview">
            {sigFile ? <img src={`data:image/png;base64,${sigFile.png}`} alt="Signature preview" /> : <span className="muted">The signature appears here</span>}
          </div>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={removeWhite}
              onChange={(e) => {
                setRemoveWhite(e.target.checked);
                if (file) void prepare(file.b64, e.target.checked);
              }}
            />{" "}
            Make the white background transparent
          </label>
        </>
      ) : (
        <>
          <p className="muted">Sign in the box with your mouse, trackpad or pen.</p>
          <div className="qs-pad">
            <SignaturePad ref={pad} ink={ink} onChange={(empty) => setDrawn(!empty)} />
            <span className="qs-pad-line" aria-hidden="true" />
          </div>
          <div className="qs-pad-tools">
            {INKS.map((k) => (
              <label key={k.color} className="inline-check">
                <input type="radio" name="ink" checked={ink === k.color} onChange={() => setInk(k.color)} /> {k.label} ink
              </label>
            ))}
            <button onClick={() => pad.current?.clear()} disabled={!drawn}>
              Clear
            </button>
          </div>
        </>
      )}
      <label>
        Name
        <input aria-label="Signature name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep this signature in Stitchup for next time
      </label>
      {keep && (
        <label className="inline-check">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Protect it with a password
        </label>
      )}
      {keep && lock && (
        <div className="qs-passwords">
          <input type="password" aria-label="Signature password" placeholder="Password" value={pw1} onChange={(e) => setPw1(e.target.value)} autoComplete="new-password" />
          <input type="password" aria-label="Repeat password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          <p className="muted">The signature is stored encrypted; Stitchup asks for this password every time it is used. A forgotten password can't be recovered — create the signature again.</p>
        </div>
      )}
      {keep && !lock && <p className="muted">Kept without a password, anyone using this Mac account can place it.</p>}
      {(error || ((mode === "file" ? sigFile : drawn) && pwProblem)) && <p className="qs-error" role="alert">{error ?? pwProblem}</p>}
      <div className="modal-actions">
        <button onClick={() => void place()} disabled={!(mode === "file" ? sigFile : drawn) || !!pwProblem || busy}>
          {keep ? "Save & Place Signature" : "Place Signature"}
        </button>
        <button onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}

/** Password prompt for a locked signature. */
export function QuickSignUnlockDialog() {
  const app = useAppState();
  const sig = app.unlockSignature;
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sig) return null;
  async function unlock() {
    if (!sig) return;
    setBusy(true);
    try {
      const png = await cmdQuickSignLoad(sig.id, pw);
      close();
      store.placeSignature(await signatureFromPng(png), sig.name);
    } catch (e) {
      setError(errText(e) === "wrong password" ? "Wrong password — try again" : errText(e));
      setPw("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Unlock “${sig.name}”`} onClose={close}>
      <p>This signature is protected. Enter its password to place it.</p>
      <input
        type="password"
        aria-label="Signature password"
        value={pw}
        autoFocus
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && pw) void unlock();
        }}
      />
      {error && <p className="qs-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button onClick={() => void unlock()} disabled={!pw || busy}>
          {busy ? "Unlocking…" : "Unlock & Place"}
        </button>
        <button onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}

function SavedRow({ s }: { s: SavedSignature }) {
  const [asking, setAsking] = useState(false);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    try {
      await cmdQuickSignDelete(s.id, s.protected ? pw : undefined);
      await store.loadSignatures();
      store.notify(`Signature “${s.name}” deleted`);
    } catch (e) {
      setError(errText(e) === "wrong password" ? "Wrong password" : errText(e));
    }
  }
  return (
    <li className="qs-row">
      <span className="qs-thumb">{s.preview ? <img src={`data:image/png;base64,${s.preview}`} alt="" /> : <span title="Protected by a password">🔒</span>}</span>
      <span className="qs-name">
        <b>{s.name}</b>
        <span className="muted"> — {s.protected ? "password protected" : "no password"}, {new Date(s.created * 1000).toLocaleDateString()}</span>
      </span>
      {asking ? (
        <span className="qs-confirm">
          {s.protected && <input type="password" aria-label={`Password for ${s.name}`} placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />}
          <button onClick={() => void remove()} disabled={s.protected && !pw}>
            Delete
          </button>
          <button onClick={() => setAsking(false)}>Keep</button>
        </span>
      ) : (
        <span className="qs-actions">
          <button
            onClick={() => {
              close();
              void store.useSignature(s);
            }}>
            Place
          </button>
          <button onClick={() => setAsking(true)}>Delete…</button>
        </span>
      )}
      {error && <span className="qs-error">{error}</span>}
    </li>
  );
}

/** QuickSign ▸ Manage Signatures. */
export function QuickSignManageDialog() {
  const app = useAppState();
  return (
    <Modal title="Saved Signatures" onClose={close}>
      {app.signatures.length ? (
        <ul className="qs-list">
          {app.signatures.map((s) => (
            <SavedRow key={s.id} s={s} />
          ))}
        </ul>
      ) : (
        <p className="muted">No saved signatures yet.</p>
      )}
      <div className="modal-actions">
        <button onClick={() => store.setDialog("quickSignNew")}>Create New Signature…</button>
        <button onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
