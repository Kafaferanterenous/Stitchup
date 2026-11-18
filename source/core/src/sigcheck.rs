//! Reading digital signatures back: who signed, when, where the box is, and
//! whether the document is still exactly what was signed.
//!
//! For each signature the signed byte ranges are hashed and compared with the
//! digest inside the CMS blob, and the signer's RSA signature over the signed
//! attributes is checked against the certificate in the blob. Identity is not
//! checked against any authority: self-signed certificates (like the ones
//! Stitchup makes) are reported as such.

use cms::cert::CertificateChoices;
use cms::content_info::ContentInfo;
use cms::signed_data::SignedData;
use der::{Decode, Encode};
use lopdf::{Dictionary, Document as PdfDoc, Object, ObjectId};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SigInfo {
    /// Signature field name ("Signature1").
    pub field: String,
    /// /Name, or the certificate's common name.
    pub name: String,
    pub reason: String,
    pub location: String,
    /// "2026-11-18 14:05 UTC" (from /M), or "".
    pub date: String,
    /// Where the visible box is (none for an invisible signature).
    pub page: Option<u32>,
    pub rect: Option<[f64; 4]>,
    /// "valid" (intact), "changed" (valid, but the file was changed after
    /// signing), "invalid" (does not match), "unknown" (not checkable).
    pub status: String,
    /// The certificate names itself as its issuer (no authority vouches for it).
    pub self_signed: bool,
    /// Certificate subject ("CN=…").
    pub subject: String,
    /// Why a signature is invalid / unknown.
    pub detail: String,
}

fn text(d: &Dictionary, k: &[u8]) -> String {
    d.get(k).ok().and_then(|o| lopdf::decode_text_string(o).ok()).unwrap_or_default().trim().to_string()
}

/// "D:20261118140500Z" → "2026-11-18 14:05 UTC" (offsets kept as given).
fn human(m: &str) -> String {
    let s = m.trim_start_matches("D:");
    let dig: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if dig.len() < 8 {
        return m.to_string();
    }
    let part = |a: usize, b: usize| dig.get(a..b).unwrap_or("00").to_string();
    let rest = &s[dig.len()..];
    let tz = match rest.chars().next() {
        Some('Z') | None => "UTC".to_string(),
        Some(_) => format!("UTC{}", rest.replace('\'', ":").trim_end_matches(':')),
    };
    format!("{}-{}-{} {}:{} {tz}", part(0, 4), part(4, 6), part(6, 8), part(8, 10), part(10, 12))
}

/// Length of the DER value at the start of `b` (CMS blobs are zero-padded).
fn der_len(b: &[u8]) -> Option<usize> {
    if b.len() < 2 || b[0] != 0x30 {
        return None;
    }
    if b[1] < 0x80 {
        return Some(2 + b[1] as usize);
    }
    let n = (b[1] & 0x7f) as usize;
    if n == 0 || n > 4 || b.len() < 2 + n {
        return None;
    }
    let len = b[2..2 + n].iter().fold(0usize, |a, x| (a << 8) | *x as usize);
    Some(2 + n + len)
}

struct Check {
    status: &'static str,
    detail: String,
    subject: String,
    self_signed: bool,
}

fn check(file: &[u8], sig: &Dictionary) -> Check {
    let bad = |status: &'static str, detail: &str| Check { status, detail: detail.into(), subject: String::new(), self_signed: false };
    let br: Vec<usize> = match sig.get(b"ByteRange").and_then(Object::as_array) {
        Ok(a) if a.len() == 4 => a.iter().filter_map(|o| o.as_i64().ok()).filter(|v| *v >= 0).map(|v| v as usize).collect(),
        _ => return bad("unknown", "no byte range"),
    };
    if br.len() != 4 || br[0] + br[1] > file.len() || br[2] + br[3] > file.len() || br[0] + br[1] > br[2] {
        return bad("invalid", "the signed byte range does not fit the file");
    }
    let covers_all = br[2] + br[3] == file.len();
    let blob = match sig.get(b"Contents") {
        Ok(Object::String(b, _)) => b.clone(),
        _ => return bad("unknown", "no signature data"),
    };
    let Some(len) = der_len(&blob).filter(|l| *l <= blob.len()) else {
        return bad("unknown", "unreadable signature data");
    };
    let sd = match ContentInfo::from_der(&blob[..len]).ok().and_then(|ci| ci.content.decode_as::<SignedData>().ok()) {
        Some(sd) => sd,
        None => return bad("unknown", "unreadable signature data"),
    };
    let cert = sd.certificates.as_ref().and_then(|c| {
        c.0.iter().find_map(|x| match x {
            CertificateChoices::Certificate(c) => Some(c.clone()),
            _ => None,
        })
    });
    let Some(cert) = cert else {
        return bad("unknown", "no certificate in the signature");
    };
    let subject = cert.tbs_certificate.subject.to_string();
    let self_signed = cert.tbs_certificate.subject == cert.tbs_certificate.issuer;
    let with = |status: &'static str, detail: &str| Check { status, detail: detail.into(), subject: subject.clone(), self_signed };
    let Some(si) = sd.signer_infos.0.iter().next() else {
        return with("unknown", "no signer");
    };
    if si.digest_alg.oid != const_oid::db::rfc5912::ID_SHA_256 {
        return with("unknown", "uses a digest Stitchup does not check (only SHA-256)");
    }
    let mut h = Sha256::new();
    h.update(&file[br[0]..br[0] + br[1]]);
    h.update(&file[br[2]..br[2] + br[3]]);
    let digest = h.finalize();
    let Some(attrs) = si.signed_attrs.as_ref() else {
        return with("unknown", "no signed attributes");
    };
    let md = attrs
        .iter()
        .find(|a| a.oid == const_oid::db::rfc5911::ID_MESSAGE_DIGEST)
        .and_then(|a| a.values.iter().next())
        .and_then(|v| v.decode_as::<der::asn1::OctetString>().ok());
    let Some(md) = md else {
        return with("unknown", "no message digest");
    };
    if md.as_bytes() != digest.as_slice() {
        return with("invalid", "the signed part of the document was changed");
    }
    let key = cert
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .ok()
        .and_then(|d| rsa::RsaPublicKey::from_public_key_der(&d).ok());
    let Some(key) = key else {
        return with("unknown", "not an RSA signature (not checked)");
    };
    let (Ok(msg), Ok(sigv)) = (attrs.to_der(), rsa::pkcs1v15::Signature::try_from(si.signature.as_bytes())) else {
        return with("unknown", "unreadable signature value");
    };
    if rsa::pkcs1v15::VerifyingKey::<Sha256>::new(key).verify(&msg, &sigv).is_err() {
        return with("invalid", "the signature does not match the certificate");
    }
    if covers_all {
        with("valid", "")
    } else {
        with("changed", "the document was changed after this signature (later edits or signatures)")
    }
}

/// Signatures in a PDF file (its bytes), in page order.
pub fn signatures(file: &[u8]) -> Vec<SigInfo> {
    let Ok(doc) = PdfDoc::load_mem(file) else {
        return vec![];
    };
    let resolve = |o: &Object| -> Option<(Option<ObjectId>, Dictionary)> {
        match o {
            Object::Reference(r) => doc.get_object(*r).ok().and_then(|x| x.as_dict().ok()).map(|d| (Some(*r), d.clone())),
            Object::Dictionary(d) => Some((None, d.clone())),
            _ => None,
        }
    };
    // Widget → page.
    let mut on_page: Vec<(ObjectId, u32)> = vec![];
    for (no, pid) in doc.get_pages() {
        if let Ok(p) = doc.get_object(pid).and_then(Object::as_dict) {
            let annots = match p.get(b"Annots") {
                Ok(Object::Array(a)) => a.clone(),
                Ok(Object::Reference(r)) => doc.get_object(*r).and_then(Object::as_array).cloned().unwrap_or_default(),
                _ => vec![],
            };
            on_page.extend(annots.iter().filter_map(|a| a.as_reference().ok()).map(|id| (id, no)));
        }
    }
    let mut out = vec![];
    let mut seen: Vec<ObjectId> = vec![];
    let mut ids: Vec<&ObjectId> = doc.objects.keys().collect();
    ids.sort();
    for id in ids {
        let Ok(w) = doc.get_object(*id).and_then(Object::as_dict) else { continue };
        // A signature field (or its widget) whose value is a /Sig dictionary.
        let Some((sig_id, sig)) = w.get(b"V").ok().and_then(resolve) else { continue };
        if sig.get(b"Type").and_then(Object::as_name).ok() != Some(b"Sig".as_slice()) && sig.get(b"ByteRange").is_err() {
            continue;
        }
        if let Some(s) = sig_id {
            if seen.contains(&s) {
                continue;
            }
            seen.push(s);
        }
        // The widget: this object, or its first kid.
        let widget = if w.get(b"Rect").is_ok() {
            Some((*id, w.clone()))
        } else {
            w.get(b"Kids")
                .and_then(Object::as_array)
                .ok()
                .and_then(|k| k.first())
                .and_then(|k| k.as_reference().ok())
                .and_then(|k| doc.get_object(k).and_then(Object::as_dict).ok().map(|d| (k, d.clone())))
        };
        let rect = widget.as_ref().and_then(|(_, d)| {
            let a: Vec<f64> = d.get(b"Rect").and_then(Object::as_array).ok()?.iter().filter_map(|v| v.as_float().ok().map(f64::from)).collect();
            (a.len() == 4 && (a[2] - a[0]).abs() >= 1.0 && (a[3] - a[1]).abs() >= 1.0).then(|| [a[0].min(a[2]), a[1].min(a[3]), a[0].max(a[2]), a[1].max(a[3])])
        });
        let page = widget.as_ref().and_then(|(wid, d)| {
            on_page.iter().find(|(x, _)| x == wid).map(|(_, n)| *n).or_else(|| {
                let p = d.get(b"P").ok()?.as_reference().ok()?;
                doc.get_pages().into_iter().find(|(_, pid)| *pid == p).map(|(n, _)| n)
            })
        });
        let c = check(file, &sig);
        let cn = c.subject.split(',').find_map(|p| p.trim().strip_prefix("CN=").map(str::to_string)).unwrap_or_default();
        let name = Some(text(&sig, b"Name")).filter(|n| !n.is_empty()).unwrap_or(cn);
        out.push(SigInfo {
            field: text(w, b"T"),
            name,
            reason: text(&sig, b"Reason"),
            location: text(&sig, b"Location"),
            date: sig.get(b"M").ok().and_then(|o| lopdf::decode_text_string(o).ok()).map(|m| human(&m)).unwrap_or_default(),
            page: rect.and(page),
            rect,
            status: c.status.into(),
            self_signed: c.self_signed,
            subject: c.subject,
            detail: c.detail,
        });
    }
    out.sort_by(|a, b| a.page.unwrap_or(u32::MAX).cmp(&b.page.unwrap_or(u32::MAX)).then(a.field.cmp(&b.field)));
    out
}
