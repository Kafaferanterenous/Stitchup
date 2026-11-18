//! Creating form fields: every type is a real AcroForm field that survives a
//! save / reload, can be filled, renamed, moved and deleted, and undo restores
//! the document.

use lopdf::{dictionary, Document as PdfDoc, Object};
use stitchup_core::formedit::{self, FieldProps, NewField};
use stitchup_core::forms::{self, FieldValue};
use stitchup_core::oplog;

fn blank() -> PdfDoc {
    let mut doc = PdfDoc::with_version("1.5");
    let pages = doc.new_object_id();
    let mut kids = vec![];
    for _ in 0..2 {
        kids.push(Object::Reference(doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()] })));
    }
    doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 2 }));
    let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", cat);
    doc
}

fn reload(d: &mut PdfDoc) -> PdfDoc {
    let mut b = Vec::new();
    d.save_to(&mut b).unwrap();
    PdfDoc::load_mem(&b).unwrap()
}

fn nf(kind: &str, name: &str, page: u32, rect: [f64; 4]) -> NewField {
    NewField { kind: kind.into(), name: name.into(), page, rect, options: vec![], value: None, required: false, font_size: 0.0 }
}

#[test]
fn every_field_type_is_created_saved_and_fillable() {
    let mut d = blank();
    assert_eq!(formedit::add_field(&mut d, &nf("text", "Full name", 1, [72.0, 700.0, 300.0, 720.0])).unwrap(), "Full name");
    formedit::add_field(&mut d, &nf("multiline", "Comments", 1, [72.0, 560.0, 400.0, 660.0])).unwrap();
    formedit::add_field(&mut d, &nf("checkbox", "Agree", 1, [72.0, 520.0, 86.0, 534.0])).unwrap();
    let mut male = nf("radio", "Gender", 1, [72.0, 480.0, 86.0, 494.0]);
    male.value = Some("Male".into());
    formedit::add_field(&mut d, &male).unwrap();
    let mut female = nf("radio", "Gender", 1, [140.0, 480.0, 154.0, 494.0]);
    female.value = Some("Female".into());
    assert_eq!(formedit::add_field(&mut d, &female).unwrap(), "Gender", "joins the group");
    let mut country = nf("choice", "Country", 2, [72.0, 700.0, 250.0, 720.0]);
    country.options = vec!["Poland".into(), "Italy".into(), " ".into()];
    formedit::add_field(&mut d, &country).unwrap();
    formedit::add_field(&mut d, &nf("signature", "Signature", 2, [72.0, 600.0, 272.0, 650.0])).unwrap();
    // Same name again: de-duplicated.
    assert_eq!(formedit::add_field(&mut d, &nf("text", "Full name", 2, [72.0, 500.0, 300.0, 520.0])).unwrap(), "Full name_2");
    // Too small, unknown type, empty drop-down: refused.
    assert!(formedit::add_field(&mut d, &nf("text", "x", 1, [0.0, 0.0, 2.0, 2.0])).is_err());
    assert!(formedit::add_field(&mut d, &nf("slider", "x", 1, [0.0, 0.0, 50.0, 50.0])).is_err());
    assert!(formedit::add_field(&mut d, &nf("choice", "x", 1, [0.0, 0.0, 50.0, 50.0])).is_err());

    let mut back = reload(&mut d);
    let list = forms::list(&back);
    let kinds: Vec<(String, String, u32)> = list.iter().map(|f| (f.name.clone(), f.kind.clone(), f.widgets[0].page)).collect();
    assert_eq!(list.len(), 7, "{kinds:?}");
    let get = |n: &str| list.iter().find(|f| f.name == n).unwrap().clone();
    assert!(get("Comments").multiline);
    assert_eq!(get("Gender").widgets.len(), 2);
    let states: Vec<_> = get("Gender").widgets.iter().map(|w| w.on_state.clone().unwrap()).collect();
    assert_eq!(states, ["Male", "Female"]);
    assert_eq!(get("Country").options, ["Poland", "Italy"]);
    assert!(get("Country").combo);
    assert_eq!(get("Signature").kind, "signature");
    assert_eq!(get("Full name_2").widgets[0].page, 2);
    // Every widget is on its page and has an appearance.
    for f in &list {
        for w in &f.widgets {
            let wd = back.get_object(w.id).unwrap().as_dict().unwrap();
            assert!(wd.has(b"AP"), "{} has an appearance", f.name);
        }
    }

    forms::set_value(&mut back, "Full name", &FieldValue::Text("Zofia Łukasiewicz".into())).unwrap();
    forms::set_value(&mut back, "Agree", &FieldValue::Bool(true)).unwrap();
    forms::set_value(&mut back, "Gender", &FieldValue::Text("Female".into())).unwrap();
    forms::set_value(&mut back, "Country", &FieldValue::Text("Italy".into())).unwrap();
    let again = reload(&mut back);
    let l2 = forms::list(&again);
    let v = |n: &str| l2.iter().find(|f| f.name == n).unwrap().value.clone();
    assert_eq!(v("Full name"), "Zofia Łukasiewicz");
    assert_eq!(v("Agree"), "Yes");
    assert_eq!(v("Gender"), "Female");
    assert_eq!(v("Country"), "Italy");
    // The catalog's form has default resources for other viewers.
    let cat = again.catalog().unwrap();
    let af = cat.get(b"AcroForm").unwrap().as_dict().unwrap();
    assert!(af.get(b"DR").unwrap().as_dict().unwrap().get(b"Font").unwrap().as_dict().unwrap().has(b"Helv"));
}

#[test]
fn fields_are_renamed_changed_moved_and_deleted_and_undo_restores() {
    let mut d = blank();
    formedit::add_field(&mut d, &nf("text", "Name", 1, [72.0, 700.0, 300.0, 720.0])).unwrap();
    let mut c = nf("choice", "Pick", 1, [72.0, 600.0, 200.0, 620.0]);
    c.options = vec!["A".into()];
    formedit::add_field(&mut d, &c).unwrap();

    let new = formedit::update_field(&mut d, &FieldProps { name: "Name".into(), new_name: Some("Surname".into()), required: Some(true), readonly: None, options: None, font_size: Some(14.0) }).unwrap();
    assert_eq!(new, "Surname");
    formedit::update_field(&mut d, &FieldProps { name: "Pick".into(), new_name: None, required: None, readonly: Some(true), options: Some(vec!["X".into(), "Y".into()]), font_size: None }).unwrap();
    assert!(formedit::update_field(&mut d, &FieldProps { name: "Pick".into(), new_name: Some("a.b".into()), required: None, readonly: None, options: None, font_size: None }).is_err());
    let l = forms::list(&d);
    let s = l.iter().find(|f| f.name == "Surname").unwrap();
    assert!(s.required);
    let p = l.iter().find(|f| f.name == "Pick").unwrap();
    assert!(p.readonly && p.options == ["X", "Y"]);

    formedit::move_field(&mut d, "Surname", 10.0, -20.0).unwrap();
    let r = forms::list(&d).into_iter().find(|f| f.name == "Surname").unwrap().widgets[0].rect;
    assert_eq!(r, [82.0, 680.0, 310.0, 700.0]);

    // Delete, with undo (snapshot like the command layer does).
    let ids = formedit::touched_ids(&d, "Surname");
    let before = oplog::with_extra(oplog::snapshot(&d).unwrap(), &d, &ids);
    formedit::remove_field(&mut d, "Surname").unwrap();
    let after = oplog::with_extra(oplog::snapshot(&d).unwrap(), &d, &ids);
    let back = reload(&mut d);
    assert_eq!(forms::list(&back).iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Pick"]);
    let page = back.get_object(*back.get_pages().get(&1).unwrap()).unwrap().as_dict().unwrap();
    assert_eq!(page.get(b"Annots").unwrap().as_array().unwrap().len(), 1, "widget left the page");
    let rec = oplog::OpRecord { label: "Delete field".into(), before, after };
    oplog::apply(&mut d, &rec, true).unwrap();
    assert_eq!(forms::list(&d).len(), 2, "undo brings the field back");
    assert!(formedit::remove_field(&mut d, "nope").is_err());
}

#[test]
fn detected_fields_are_added_in_one_batch_with_fresh_radio_groups() {
    let mut d = blank();
    let mut old = nf("radio", "Gender", 1, [72.0, 300.0, 86.0, 314.0]);
    old.value = Some("Yes".into());
    formedit::add_field(&mut d, &old).unwrap();
    let mut a = nf("radio", "Gender", 1, [72.0, 480.0, 86.0, 494.0]);
    a.value = Some("Male".into());
    let mut b = nf("radio", "Gender", 1, [140.0, 480.0, 154.0, 494.0]);
    b.value = Some("Female".into());
    let specs = vec![nf("text", "Email", 1, [72.0, 700.0, 300.0, 720.0]), a, b, nf("checkbox", "Agree", 2, [72.0, 520.0, 86.0, 534.0])];
    let names = formedit::add_fields(&mut d, &specs).unwrap();
    assert_eq!(names, vec!["Email", "Gender_2", "Gender_2", "Agree"]);
    let back = reload(&mut d);
    let list = forms::list(&back);
    assert_eq!(list.len(), 4);
    let g = list.iter().find(|f| f.name == "Gender_2").unwrap();
    assert_eq!(g.widgets.len(), 2, "both detected buttons form one new group");
    assert_eq!(list.iter().find(|f| f.name == "Gender").unwrap().widgets.len(), 1, "the old group is left alone");
}

#[test]
fn fields_are_resized_and_redrawn_at_the_new_size() {
    let mut d = blank();
    formedit::add_field(&mut d, &nf("text", "Name", 1, [72.0, 700.0, 200.0, 720.0])).unwrap();
    formedit::add_field(&mut d, &nf("checkbox", "Agree", 1, [72.0, 600.0, 86.0, 614.0])).unwrap();
    let mut a = nf("radio", "Size", 1, [72.0, 500.0, 86.0, 514.0]);
    a.value = Some("Small".into());
    formedit::add_field(&mut d, &a).unwrap();
    formedit::add_field(&mut d, &nf("signature", "Sign", 1, [72.0, 400.0, 200.0, 440.0])).unwrap();
    let bbox = |d: &PdfDoc, id: (u32, u16)| -> Vec<f64> {
        let w = d.get_object(id).unwrap().as_dict().unwrap();
        let n = w.get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap();
        let s = match n {
            Object::Reference(r) => d.get_object(*r).unwrap(),
            o => o,
        };
        let s = match s {
            Object::Stream(s) => s.clone(),
            // radio / check box: /N << /On … /Off … >>
            Object::Dictionary(dd) => {
                let (_, v) = dd.iter().next().unwrap();
                d.get_object(v.as_reference().unwrap()).unwrap().as_stream().unwrap().clone()
            }
            _ => panic!("no appearance"),
        };
        s.dict.get(b"BBox").unwrap().as_array().unwrap().iter().map(|v| v.as_float().unwrap() as f64).collect()
    };
    for (name, rect) in [("Name", [72.0, 690.0, 300.0, 720.0]), ("Agree", [72.0, 600.0, 92.0, 620.0]), ("Size", [72.0, 500.0, 94.0, 522.0]), ("Sign", [72.0, 380.0, 272.0, 440.0])] {
        let f = forms::list(&d).into_iter().find(|f| f.name == name).unwrap();
        let id = f.widgets[0].id;
        formedit::resize_field(&mut d, name, id, rect).unwrap();
        let back = reload(&mut d);
        let f = forms::list(&back).into_iter().find(|f| f.name == name).unwrap();
        let r = f.widgets[0].rect;
        assert!((r[2] - rect[2]).abs() < 0.01 && (r[1] - rect[1]).abs() < 0.01, "{name}: {r:?}");
        let b = bbox(&d, id);
        assert!((b[2] - (rect[2] - rect[0])).abs() < 0.01 && (b[3] - (rect[3] - rect[1])).abs() < 0.01, "{name} redrawn at the new size: {b:?}");
    }
    let first = forms::list(&d)[0].widgets[0].id;
    assert!(formedit::resize_field(&mut d, "Name", first, [0.0, 0.0, 2.0, 2.0]).is_err(), "too small");
}
