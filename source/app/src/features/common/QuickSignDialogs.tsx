//! QuickSign dialogs: create a signature from an image, unlock a
//! password-protected one, and manage the saved ones.

import { useRef, useState } from "react";
import { INKS, SignaturePad, type SignaturePadHandle } from "./SignaturePad";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { store, useAppState } from "../../store";
import { cmdQuickSignDelete, cmdQuickSignLoad, cmdQuickSignSave, cmdReadImage, type SavedSignature } from "../../ipc";
import { prepareSignature, signatureFromPng, type PreparedSignature } from "../../quicksign";

import { tr } from "../../i18n";

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
      setError(tr("Could not read that image: {0}", errText(e)));
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
        if (!png) throw new Error(tr("draw your signature first"));
        sig = await prepareSignature(png, false);
      }
      if (!sig) return;
      let note: string | undefined;
      if (keep) {
        try {
          await cmdQuickSignSave(name, sig.png, lock ? pw1 : undefined);
          await store.loadSignatures();
          note = lock ? tr("Signature “{0}” saved, locked with a password", name) : tr("Signature “{0}” saved for next time", name);
        } catch (e) {
          // Keeping it failed (e.g. the folder is blocked): still let the user sign.
          note = tr("Could not keep the signature ({0}) — placing it this once", errText(e));
        }
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
    <Modal title={tr("Create New Signature")} onClose={close}>
      <div className="qs-modes" role="tablist" aria-label="Signature source">
        <button role="tab" aria-selected={mode === "file"} className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>
          {tr("From File")}
        </button>
        <button role="tab" aria-selected={mode === "draw"} className={mode === "draw" ? "on" : ""} onClick={() => setMode("draw")}>
          {tr("Draw")}
        </button>
      </div>
      {mode === "file" ? (
        <>
          <p className="muted">{tr("Choose a photo or scan of your handwritten signature (JPG, GIF or PNG). Sign on white paper with a dark pen for the best result.")}</p>
          <div className="qs-pick">
            <button onClick={() => void choose()}>{file ? tr("Choose Another Image…") : tr("Choose Image…")}</button>
            <span className="muted">{file?.name ?? tr("No image chosen")}</span>
          </div>
          <div className="qs-preview" aria-label="Signature preview">
            {sigFile ? <img src={`data:image/png;base64,${sigFile.png}`} alt={tr("Signature preview")} /> : <span className="muted">{tr("The signature appears here")}</span>}
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
            {tr("Make the white background transparent")}
          </label>
        </>
      ) : (
        <>
          <p className="muted">{tr("Sign in the box with your mouse, trackpad or pen.")}</p>
          <div className="qs-pad">
            <SignaturePad ref={pad} ink={ink} onChange={(empty) => setDrawn(!empty)} />
            <span className="qs-pad-line" aria-hidden="true" />
          </div>
          <div className="qs-pad-tools">
            {INKS.map((k) => (
              <label key={k.color} className="inline-check">
                <input type="radio" name="ink" checked={ink === k.color} onChange={() => setInk(k.color)} /> {tr(`${k.label} ink`)}
              </label>
            ))}
            <button onClick={() => pad.current?.clear()} disabled={!drawn}>
              {tr("Clear")}
            </button>
          </div>
        </>
      )}
      <label>
        {tr("Name")}
        <input aria-label="Signature name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> {tr("Keep this signature in Stitchup for next time")}
      </label>
      {keep && (
        <label className="inline-check">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> {tr("Protect it with a password")}
        </label>
      )}
      {keep && lock && (
        <div className="qs-passwords">
          <input type="password" aria-label="Signature password" placeholder={tr("Password")} value={pw1} onChange={(e) => setPw1(e.target.value)} autoComplete="new-password" />
          <input type="password" aria-label="Repeat password" placeholder={tr("Repeat password")} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          <p className="muted">{tr("The signature is stored encrypted; Stitchup asks for this password every time it is used. A forgotten password can't be recovered — create the signature again.")}</p>
        </div>
      )}
      {keep && !lock && <p className="muted">{tr("Kept without a password, anyone using this Mac account can place it.")}</p>}
      {(error || ((mode === "file" ? sigFile : drawn) && pwProblem)) && <p className="qs-error" role="alert">{error ?? pwProblem}</p>}
      <div className="modal-actions">
        <button onClick={() => void place()} disabled={!(mode === "file" ? sigFile : drawn) || !!pwProblem || busy}>
          {keep ? tr("Save & Place Signature") : tr("Place Signature")}
        </button>
        <button onClick={close}>{tr("Cancel")}</button>
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
      setError(errText(e) === "wrong password" ? tr("Wrong password — try again") : errText(e));
      setPw("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Unlock “${sig.name}”`} onClose={close}>
      <p>{tr("This signature is protected. Enter its password to place it.")}</p>
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
          {busy ? tr("Unlocking…") : tr("Unlock & Place")}
        </button>
        <button onClick={close}>{tr("Cancel")}</button>
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
      store.notify(tr("Signature “{0}” deleted", s.name));
    } catch (e) {
      setError(errText(e) === "wrong password" ? tr("Wrong password") : errText(e));
    }
  }
  return (
    <li className="qs-row">
      <span className="qs-thumb">{s.preview ? <img src={`data:image/png;base64,${s.preview}`} alt="" /> : <span title={tr("Protected by a password")}>🔒</span>}</span>
      <span className="qs-name">
        <b>{s.name}</b>
        <span className="muted"> — {s.protected ? tr("password protected") : tr("no password")}, {new Date(s.created * 1000).toLocaleDateString()}</span>
      </span>
      {asking ? (
        <span className="qs-confirm">
          {s.protected && <input type="password" aria-label={`Password for ${s.name}`} placeholder={tr("Password")} value={pw} onChange={(e) => setPw(e.target.value)} />}
          <button onClick={() => void remove()} disabled={s.protected && !pw}>
            {tr("Delete")}
          </button>
          <button onClick={() => setAsking(false)}>{tr("Keep")}</button>
        </span>
      ) : (
        <span className="qs-actions">
          <button
            onClick={() => {
              close();
              void store.useSignature(s);
            }}>
            {tr("Place")}
          </button>
          <button onClick={() => setAsking(true)}>{tr("Delete…")}</button>
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
    <Modal title={tr("Saved Signatures")} onClose={close}>
      {app.signatures.length ? (
        <ul className="qs-list">
          {app.signatures.map((s) => (
            <SavedRow key={s.id} s={s} />
          ))}
        </ul>
      ) : (
        <p className="muted">{tr("No saved signatures yet.")}</p>
      )}
      <div className="modal-actions">
        <button onClick={() => store.setDialog("quickSignNew")}>{tr("Create New Signature…")}</button>
        <button onClick={close}>{tr("Close")}</button>
      </div>
    </Modal>
  );
}
