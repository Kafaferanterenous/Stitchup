//! Form creation (PDF 32000 §12.7): add new fields to a page, change their
//! properties, move and delete them. Fields get real appearances (border,
//! check mark, radio dot, drop-down arrow) so they look right in every viewer
//! and when printed, and are filled with [`crate::forms::set_value`].
//!
//! Undo: the catalog, the /AcroForm dictionary, its /Fields array and any
//! radio group that gains a button are modified in place — callers snapshot
//! [`touched_ids`] (see `oplog::with_extra`); page /Annots are covered by the
//! ordinary page snapshot.

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Document as PdfDoc, Object, ObjectId, Stream};
use serde::Deserialize;

use crate::annots::{annots_of, page_id, set_annots};
use crate::error::{EngineError, ErrorCode};
use crate::forms::{self, Deco};

/// Ff bits.
const READ_ONLY: i64 = 1;
const REQUIRED: i64 = 1 << 1;
const MULTILINE: i64 = 1 << 12;
const NO_TOGGLE_OFF: i64 = 1 << 14;
const RADIO: i64 = 1 << 15;
const COMBO: i64 = 1 << 17;

const BORDER: [f64; 3] = [0.55, 0.55, 0.6];

#[derive(Debug, Clone, Deserialize)]
pub struct NewField {
    /// "text" | "multiline" | "checkbox" | "radio" | "choice" | "signature"
    pub kind: String,
    /// Field name; a radio button with the name of an existing radio group
    /// joins that group.
    pub name: String,
    pub page: u32,
    /// User space [x0, y0, x1, y1].
    pub rect: [f64; 4],
    /// Drop-down entries.
    #[serde(default)]
    pub options: Vec<String>,
    /// Radio button: the value this button stands for ("Yes", "Male"…).
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub required: bool,
    /// Text size in points; 0 = fit to the box.
    #[serde(default)]
    pub font_size: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FieldProps {
    pub name: String,
    #[serde(default)]
    pub new_name: Option<String>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub readonly: Option<bool>,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub font_size: Option<f64>,
}

fn r(v: f64) -> Object {
    Object::Real(v as f32)
}

fn norm(a: [f64; 4]) -> [f64; 4] {
    [a[0].min(a[2]), a[1].min(a[3]), a[0].max(a[2]), a[1].max(a[3])]
}

fn catalog_id(doc: &PdfDoc) -> Result<ObjectId, EngineError> {
    Ok(doc.trailer.get(b"Root")?.as_reference()?)
}

/// Objects a form edit may change in place: catalog, /AcroForm and /Fields
/// when indirect, plus the field's own objects and its parent group.
pub fn touched_ids(doc: &PdfDoc, name: &str) -> Vec<ObjectId> {
    let mut ids = vec![];
    if let Ok(c) = catalog_id(doc) {
        ids.push(c);
        if let Ok(af) = doc.get_object(c).and_then(Object::as_dict).and_then(|d| d.get(b"AcroForm")) {
            if let Ok(id) = af.as_reference() {
                ids.push(id);
            }
            let afd = match af {
                Object::Reference(id) => doc.get_object(*id).and_then(Object::as_dict).ok(),
                o => o.as_dict().ok(),
            };
            if let Some(Ok(id)) = afd.and_then(|d| d.get(b"Fields").ok()).map(Object::as_reference) {
                ids.push(id);
            }
        }
    }
    ids.extend(forms::touched(doc, name));
    ids.sort();
    ids.dedup();
    ids
}

/// The /AcroForm dictionary (created if missing), as an owned copy plus where
/// it lives, so it can be written back.
enum AfHome {
    Inline,
    Object(ObjectId),
}

fn acroform(doc: &mut PdfDoc) -> Result<(Dictionary, AfHome), EngineError> {
    let cat = catalog_id(doc)?;
    let c = doc.get_object(cat)?.as_dict()?;
    let (mut af, home) = match c.get(b"AcroForm") {
        Ok(Object::Reference(id)) => (doc.get_object(*id)?.as_dict()?.clone(), AfHome::Object(*id)),
        Ok(Object::Dictionary(d)) => (d.clone(), AfHome::Inline),
        _ => (Dictionary::new(), AfHome::Inline),
    };
    if !af.has(b"Fields") {
        af.set("Fields", Object::Array(vec![]));
    }
    if !af.has(b"DA") {
        af.set("DA", Object::string_literal("/Helv 0 Tf 0 g"));
    }
    // Default resources, so other viewers can regenerate appearances.
    let mut dr = af.get(b"DR").ok().and_then(|o| o.as_dict().ok()).cloned().unwrap_or_default();
    let mut fonts = dr.get(b"Font").ok().and_then(|o| o.as_dict().ok()).cloned().unwrap_or_default();
    if !fonts.has(b"Helv") {
        fonts.set("Helv", dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" });
    }
    if !fonts.has(b"ZaDb") {
        fonts.set("ZaDb", dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "ZapfDingbats" });
    }
    dr.set("Font", fonts);
    af.set("DR", dr);
    Ok((af, home))
}

fn put_acroform(doc: &mut PdfDoc, af: Dictionary, home: AfHome) -> Result<(), EngineError> {
    match home {
        AfHome::Object(id) => {
            doc.objects.insert(id, Object::Dictionary(af));
        }
        AfHome::Inline => {
            let cat = catalog_id(doc)?;
            doc.get_object_mut(cat)?.as_dict_mut()?.set("AcroForm", Object::Dictionary(af));
        }
    }
    Ok(())
}

/// The /Fields array (resolving an indirect one) and a setter.
fn fields_of(doc: &PdfDoc, af: &Dictionary) -> Vec<Object> {
    match af.get(b"Fields") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(id)) => doc.get_object(*id).and_then(Object::as_array).cloned().unwrap_or_default(),
        _ => vec![],
    }
}

fn set_fields(doc: &mut PdfDoc, af: &mut Dictionary, fields: Vec<Object>) {
    match af.get(b"Fields") {
        Ok(Object::Reference(id)) => {
            let id = *id;
            doc.objects.insert(id, Object::Array(fields));
        }
        _ => af.set("Fields", Object::Array(fields)),
    }
}

/// A PDF-name-safe button value ("Mr. Smith" → "Mr._Smith").
fn button_value(v: &str) -> String {
    let s: String = v.trim().chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if s.is_empty() { "Choice".into() } else { s }
}

/// A free name: `base`, or `base_2`, `base_3`…
fn unique_name(doc: &PdfDoc, base: &str) -> String {
    let taken: std::collections::HashSet<String> = forms::list(doc).into_iter().map(|f| f.name).collect();
    let base = if base.trim().is_empty() { "Field" } else { base.trim() };
    if !taken.contains(base) {
        return base.to_string();
    }
    (2..).map(|i| format!("{base}_{i}")).find(|n| !taken.contains(n)).unwrap()
}

fn widget_base(page: ObjectId, rect: [f64; 4]) -> Dictionary {
    dictionary! {
        "Type" => "Annot",
        "Subtype" => "Widget",
        "Rect" => rect.iter().map(|v| r(*v)).collect::<Vec<_>>(),
        "P" => page,
        "F" => 4,
        "BS" => dictionary! { "W" => 1, "S" => "S" },
    }
}

/// Radio button appearances: a circle, and the circle with a dot when on.
fn radio_appearance(doc: &mut PdfDoc, rect: [f64; 4], on: &str) -> Dictionary {
    let (w, h) = (rect[2] - rect[0], rect[3] - rect[1]);
    let s = w.min(h);
    let (cx, cy) = (w / 2.0, h / 2.0);
    let circle = |rad: f64, paint: &str| -> Vec<Operation> {
        let k = 0.552_284_75 * rad;
        vec![
            Operation::new("m", vec![r(cx + rad), r(cy)]),
            Operation::new("c", vec![r(cx + rad), r(cy + k), r(cx + k), r(cy + rad), r(cx), r(cy + rad)]),
            Operation::new("c", vec![r(cx - k), r(cy + rad), r(cx - rad), r(cy + k), r(cx - rad), r(cy)]),
            Operation::new("c", vec![r(cx - rad), r(cy - k), r(cx - k), r(cy - rad), r(cx), r(cy - rad)]),
            Operation::new("c", vec![r(cx + k), r(cy - rad), r(cx + rad), r(cy - k), r(cx + rad), r(cy)]),
            Operation::new(paint, vec![]),
        ]
    };
    let mut off = vec![Operation::new("q", vec![]), Operation::new("RG", BORDER.iter().map(|v| r(*v)).collect()), Operation::new("w", vec![r(0.75)])];
    off.extend(circle(s / 2.0 - 0.6, "S"));
    off.push(Operation::new("Q", vec![]));
    let mut onv = off.clone();
    onv.extend([Operation::new("q", vec![]), Operation::new("g", vec![r(0.0)])]);
    onv.extend(circle(s * 0.22, "f"));
    onv.push(Operation::new("Q", vec![]));
    let bbox = vec![0.into(), 0.into(), r(w), r(h)];
    let mk = |doc: &mut PdfDoc, ops: Vec<Operation>| {
        doc.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => bbox.clone() }, Content { operations: ops }.encode().unwrap_or_default()))
    };
    let on_id = mk(doc, onv);
    let off_id = mk(doc, off);
    let mut n = Dictionary::new();
    n.set(on.as_bytes().to_vec(), on_id);
    n.set("Off", off_id);
    dictionary! { "N" => n }
}

/// Add a form field; returns its (possibly de-duplicated) name.
pub fn add_field(doc: &mut PdfDoc, spec: &NewField) -> Result<String, EngineError> {
    let page = page_id(doc, spec.page)?;
    let rect = norm(spec.rect);
    if rect[2] - rect[0] < 4.0 || rect[3] - rect[1] < 4.0 {
        return Err(crate::err!(ErrorCode::ValidationFailed, "drag a larger box for the field"));
    }
    let (mut af, home) = acroform(doc)?;
    let mut fields = fields_of(doc, &af);
    let size = spec.font_size.clamp(0.0, 72.0);
    let da = format!("/Helv {size} Tf 0 g");
    let mk_border = || dictionary! { "BC" => BORDER.iter().map(|v| r(*v)).collect::<Vec<_>>() };
    let req = if spec.required { REQUIRED } else { 0 };

    // A radio button joining an existing group.
    if spec.kind == "radio" {
        if let Some(group) = forms::list(doc).into_iter().find(|f| f.name == spec.name.trim() && f.kind == "radio") {
            let gid = group.field_id.ok_or_else(|| crate::err!(ErrorCode::Malformed, "radio group without an object"))?;
            let value = button_value(spec.value.as_deref().unwrap_or("Choice"));
            if group.widgets.iter().any(|w| w.on_state.as_deref() == Some(value.as_str())) {
                return Err(crate::err!(ErrorCode::ValidationFailed, "the group {} already has a button for {value}", group.name));
            }
            let mut w = widget_base(page, rect);
            w.set("Parent", gid);
            w.set("AS", "Off");
            w.set("MK", dictionary! { "BC" => BORDER.iter().map(|v| r(*v)).collect::<Vec<_>>(), "CA" => Object::string_literal("l") });
            let ap = radio_appearance(doc, rect, &value);
            w.set("AP", ap);
            let wid = doc.add_object(w);
            let g = doc.get_object_mut(gid)?.as_dict_mut()?;
            let mut kids = g.get(b"Kids").ok().and_then(|o| o.as_array().ok()).cloned().unwrap_or_default();
            kids.push(Object::Reference(wid));
            g.set("Kids", kids);
            add_to_page(doc, page, wid)?;
            put_acroform(doc, af, home)?;
            return Ok(group.name);
        }
    }

    let name = unique_name(doc, &spec.name);
    let mut d = widget_base(page, rect);
    d.set("T", lopdf::text_string(&name));
    d.set("MK", mk_border());
    let id = match spec.kind.as_str() {
        "text" | "multiline" => {
            let ml = spec.kind == "multiline";
            d.set("FT", "Tx");
            d.set("Ff", req | if ml { MULTILINE } else { 0 });
            d.set("DA", Object::string_literal(da.clone()));
            d.set("V", lopdf::text_string(""));
            let ap = forms::text_appearance(doc, rect, "", &da, ml, Deco { border: Some(BORDER), arrow: false })?;
            d.set("AP", dictionary! { "N" => ap });
            doc.add_object(d)
        }
        "choice" => {
            let opts: Vec<String> = spec.options.iter().map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect();
            if opts.is_empty() {
                return Err(crate::err!(ErrorCode::ValidationFailed, "a drop-down needs at least one choice"));
            }
            d.set("FT", "Ch");
            d.set("Ff", req | COMBO);
            d.set("DA", Object::string_literal(da.clone()));
            d.set("Opt", opts.iter().map(|o| lopdf::text_string(o)).collect::<Vec<_>>());
            d.set("V", lopdf::text_string(""));
            let ap = forms::text_appearance(doc, rect, "", &da, false, Deco { border: Some(BORDER), arrow: true })?;
            d.set("AP", dictionary! { "N" => ap });
            doc.add_object(d)
        }
        "checkbox" => {
            d.set("FT", "Btn");
            d.set("Ff", req);
            d.set("V", "Off");
            d.set("AS", "Off");
            d.set("MK", dictionary! { "BC" => BORDER.iter().map(|v| r(*v)).collect::<Vec<_>>(), "CA" => Object::string_literal("4") });
            let id = doc.add_object(d);
            forms::check_appearance(doc, id, rect, "Yes", Some(BORDER))?;
            id
        }
        "radio" => {
            let value = button_value(spec.value.as_deref().unwrap_or("Choice"));
            // The group (field) and its first button (widget).
            let group = dictionary! {
                "FT" => "Btn",
                "Ff" => req | RADIO | NO_TOGGLE_OFF,
                "T" => lopdf::text_string(&name),
                "V" => "Off",
                "Kids" => Vec::<Object>::new(),
            };
            let gid = doc.add_object(group);
            let mut w = widget_base(page, rect);
            w.set("Parent", gid);
            w.set("AS", "Off");
            w.set("MK", dictionary! { "BC" => BORDER.iter().map(|v| r(*v)).collect::<Vec<_>>(), "CA" => Object::string_literal("l") });
            let ap = radio_appearance(doc, rect, &value);
            w.set("AP", ap);
            let wid = doc.add_object(w);
            doc.get_object_mut(gid)?.as_dict_mut()?.set("Kids", vec![Object::Reference(wid)]);
            fields.push(Object::Reference(gid));
            set_fields(doc, &mut af, fields);
            add_to_page(doc, page, wid)?;
            put_acroform(doc, af, home)?;
            return Ok(name);
        }
        "signature" => {
            d.set("FT", "Sig");
            d.set("Ff", req);
            let (w, h) = (rect[2] - rect[0], rect[3] - rect[1]);
            let mut ops = Deco { border: Some(BORDER), arrow: false }.ops(w, h);
            // A baseline to sign on.
            ops.extend([
                Operation::new("q", vec![]),
                Operation::new("RG", BORDER.iter().map(|v| r(*v)).collect()),
                Operation::new("w", vec![r(0.5)]),
                Operation::new("m", vec![r(6.0), r(h * 0.28)]),
                Operation::new("l", vec![r(w - 6.0), r(h * 0.28)]),
                Operation::new("S", vec![]),
                Operation::new("Q", vec![]),
            ]);
            let ap = doc.add_object(Stream::new(
                dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), r(w), r(h)] },
                Content { operations: ops }.encode()?,
            ));
            d.set("AP", dictionary! { "N" => ap });
            doc.add_object(d)
        }
        other => return Err(crate::err!(ErrorCode::ValidationFailed, "unknown field type {other}")),
    };
    fields.push(Object::Reference(id));
    set_fields(doc, &mut af, fields);
    add_to_page(doc, page, id)?;
    put_acroform(doc, af, home)?;
    Ok(name)
}

/// Add several fields at once (Detect Fields). Radio buttons that share a
/// `name` in the batch form one new group, even if the document already has
/// a group by that name. Returns the final names, in order.
pub fn add_fields(doc: &mut PdfDoc, specs: &[NewField]) -> Result<Vec<String>, EngineError> {
    let mut groups: std::collections::HashMap<String, String> = Default::default();
    let mut out = Vec::with_capacity(specs.len());
    for spec in specs {
        let mut s = spec.clone();
        if s.kind == "radio" {
            let key = s.name.trim().to_string();
            match groups.get(&key) {
                Some(real) => s.name = real.clone(),
                None => s.name = unique_name(doc, &key),
            }
            let name = add_field(doc, &s)?;
            groups.insert(key, name.clone());
            out.push(name);
        } else {
            out.push(add_field(doc, &s)?);
        }
    }
    Ok(out)
}

fn add_to_page(doc: &mut PdfDoc, page: ObjectId, widget: ObjectId) -> Result<(), EngineError> {
    let mut annots = annots_of(doc, doc.get_object(page)?.as_dict()?);
    annots.push(Object::Reference(widget));
    set_annots(doc, page, annots)
}

/// Delete a field: its widgets leave their pages and the field leaves the
/// form (or its parent's /Kids).
pub fn remove_field(doc: &mut PdfDoc, name: &str) -> Result<(), EngineError> {
    let f = forms::list(doc).into_iter().find(|f| f.name == name).ok_or_else(|| crate::err!(ErrorCode::ValidationFailed, "no field {name}"))?;
    let widget_ids: Vec<ObjectId> = f.widgets.iter().map(|w| w.id).collect();
    for (_, pid) in doc.get_pages() {
        let annots = annots_of(doc, doc.get_object(pid)?.as_dict()?);
        let kept: Vec<Object> = annots.iter().filter(|a| a.as_reference().map(|r| !widget_ids.contains(&r)).unwrap_or(true)).cloned().collect();
        if kept.len() != annots.len() {
            set_annots(doc, pid, kept)?;
        }
    }
    let fid = f.field_id.or_else(|| widget_ids.first().copied());
    let (mut af, home) = acroform(doc)?;
    let fields = fields_of(doc, &af);
    let gone = |o: &Object| o.as_reference().ok().map(|r| Some(r) == fid || widget_ids.contains(&r)).unwrap_or(false);
    let kept: Vec<Object> = fields.iter().filter(|o| !gone(o)).cloned().collect();
    if kept.len() != fields.len() {
        set_fields(doc, &mut af, kept);
    } else if let Some(fid) = fid {
        // A child field: remove it from its parent's /Kids.
        let parent = doc.get_object(fid).ok().and_then(|o| o.as_dict().ok()).and_then(|d| d.get(b"Parent").ok()).and_then(|o| o.as_reference().ok());
        if let Some(pid) = parent {
            let p = doc.get_object_mut(pid)?.as_dict_mut()?;
            let kids: Vec<Object> = p.get(b"Kids").ok().and_then(|o| o.as_array().ok()).cloned().unwrap_or_default().into_iter().filter(|o| !gone(o)).collect();
            p.set("Kids", kids);
        }
    }
    put_acroform(doc, af, home)
}

/// Rename a field and change its flags / choices / text size, then redraw it.
pub fn update_field(doc: &mut PdfDoc, props: &FieldProps) -> Result<String, EngineError> {
    let f = forms::list(doc).into_iter().find(|f| f.name == props.name).ok_or_else(|| crate::err!(ErrorCode::ValidationFailed, "no field {}", props.name))?;
    let fid = f.field_id.or_else(|| f.widgets.first().map(|w| w.id)).ok_or_else(|| crate::err!(ErrorCode::Malformed, "field has no object"))?;
    let mut name = f.name.clone();
    if let Some(n) = props.new_name.as_deref().map(str::trim).filter(|n| !n.is_empty() && *n != f.name) {
        if n.contains('.') {
            return Err(crate::err!(ErrorCode::ValidationFailed, "a field name can't contain a full stop"));
        }
        name = unique_name(doc, n);
    }
    let d = doc.get_object_mut(fid)?.as_dict_mut()?;
    if name != f.name {
        // Only the last part of a dotted name belongs to this object.
        let partial = name.rsplit('.').next().unwrap_or(&name).to_string();
        d.set("T", lopdf::text_string(&partial));
    }
    let mut ff = d.get(b"Ff").ok().and_then(|o| o.as_i64().ok()).unwrap_or(0);
    for (flag, on) in [(REQUIRED, props.required), (READ_ONLY, props.readonly)] {
        if let Some(on) = on {
            ff = if on { ff | flag } else { ff & !flag };
        }
    }
    d.set("Ff", ff);
    if let (Some(opts), "choice") = (&props.options, f.kind.as_str()) {
        let opts: Vec<Object> = opts.iter().map(|o| o.trim()).filter(|o| !o.is_empty()).map(lopdf::text_string).collect();
        if opts.is_empty() {
            return Err(crate::err!(ErrorCode::ValidationFailed, "a drop-down needs at least one choice"));
        }
        d.set("Opt", opts);
    }
    if let Some(size) = props.font_size {
        if matches!(f.kind.as_str(), "text" | "choice") {
            d.set("DA", Object::string_literal(format!("/Helv {} Tf 0 g", size.clamp(0.0, 72.0))));
        }
    }
    // Redraw text-like fields with their value (read-only does not block us).
    if matches!(f.kind.as_str(), "text" | "choice") {
        let f2 = forms::list(doc).into_iter().find(|x| x.name == name).ok_or_else(|| crate::err!(ErrorCode::Malformed, "field vanished"))?;
        for w in &f2.widgets {
            let deco = Deco { border: forms::mk_border(doc, w.id), arrow: f2.kind == "choice" && f2.combo };
            let ap = forms::text_appearance(doc, w.rect, &f2.value, &f2.da, f2.multiline, deco)?;
            doc.get_object_mut(w.id)?.as_dict_mut()?.set("AP", dictionary! { "N" => ap });
        }
    }
    Ok(name)
}

/// Move all of a field's widgets by (dx, dy) points. Appearances are drawn
/// relative to the box, so they move with it.
pub fn move_field(doc: &mut PdfDoc, name: &str, dx: f64, dy: f64) -> Result<(), EngineError> {
    let f = forms::list(doc).into_iter().find(|f| f.name == name).ok_or_else(|| crate::err!(ErrorCode::ValidationFailed, "no field {name}"))?;
    for w in &f.widgets {
        let rect = [w.rect[0] + dx, w.rect[1] + dy, w.rect[2] + dx, w.rect[3] + dy];
        doc.get_object_mut(w.id)?.as_dict_mut()?.set("Rect", rect.iter().map(|v| r(*v)).collect::<Vec<_>>());
    }
    Ok(())
}
