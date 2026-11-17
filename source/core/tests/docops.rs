//! Whole-document operations: new, watermark, crop, encrypt, compress, attachments.

use lopdf::{Document as PdfDoc, LoadOptions, Object};
use stitchup_core::collect_pages;
use stitchup_core::docops::*;

fn roundtrip(doc: &mut PdfDoc) -> PdfDoc {
    let mut data = Vec::new();
    doc.save_to(&mut data).unwrap();
    PdfDoc::load_mem(&data).unwrap()
}

#[test]
fn new_blank_is_a_valid_one_page_document() {
    let mut d = new_blank(595.0, 842.0).unwrap();
    let back = roundtrip(&mut d);
    let p = collect_pages(&back).unwrap();
    assert_eq!(p.len(), 1);
    assert_eq!((p[0].width_pt.round(), p[0].height_pt.round()), (595.0, 842.0));
    assert!(new_blank(0.0, 10.0).is_err());
}

fn spec(text: &str, placement: Placement, pages: Vec<u32>) -> WatermarkSpec {
    WatermarkSpec { text: text.into(), size: 48.0, placement, opacity: 0.5, color: [0.5, 0.5, 0.5], pages }
}

#[test]
fn watermark_is_drawn_on_every_page_and_keeps_original_text() {
    let mut d = new_blank(612.0, 792.0).unwrap();
    // second page, rotated
    let mut other = new_blank(400.0, 600.0).unwrap();
    other.get_object_mut(*other.get_pages().get(&1).unwrap()).unwrap().as_dict_mut().unwrap().set("Rotate", 90);
    stitchup_core::merge_doc(&mut d, &other).unwrap();
    assert_eq!(watermark(&mut d, &spec("CONFIDENTIAL", Placement::Center, vec![])).unwrap(), 2);
    assert_eq!(watermark(&mut d, &spec("Draft", Placement::Tiled, vec![2])).unwrap(), 1);
    assert_eq!(watermark(&mut d, &spec("Top", Placement::Top, vec![1])).unwrap(), 1);
    let back = roundtrip(&mut d);
    for n in [1, 2] {
        assert!(back.extract_text(&[n]).unwrap().contains("CONFIDENTIAL"), "page {n}");
    }
    assert!(back.extract_text(&[2]).unwrap().matches("Draft").count() > 3, "tiled repeats");
    assert!(watermark(&mut d, &spec("  ", Placement::Center, vec![])).is_err());
}

#[test]
fn crop_box_changes_the_visible_page_size() {
    let mut d = new_blank(612.0, 792.0).unwrap();
    set_crop_box(&mut d, 1, [50.0, 60.0, 350.0, 460.0]).unwrap();
    let p = collect_pages(&d).unwrap();
    assert_eq!((p[0].width_pt.round(), p[0].height_pt.round()), (300.0, 400.0));
    // Clamped to the MediaBox; degenerate boxes refused.
    set_crop_box(&mut d, 1, [-100.0, -100.0, 9999.0, 9999.0]).unwrap();
    assert_eq!(collect_pages(&d).unwrap()[0].width_pt.round(), 612.0);
    assert!(set_crop_box(&mut d, 1, [10.0, 10.0, 11.0, 11.0]).is_err());
}

#[test]
fn encrypted_copy_needs_the_password_and_leaves_the_original_open() {
    let mut d = new_blank(612.0, 792.0).unwrap();
    watermark(&mut d, &spec("SECRET", Placement::Center, vec![])).unwrap();
    let mut enc = encrypted_copy(&d, "user-pw", "owner-pw").unwrap();
    let mut data = Vec::new();
    enc.save_to(&mut data).unwrap();
    assert!(String::from_utf8_lossy(&data).contains("/Encrypt"));
    // Without the password the text can't be read.
    let no_pw = PdfDoc::load_mem(&data);
    assert!(no_pw.map(|d| d.is_encrypted()).unwrap_or(true));
    let opened = PdfDoc::load_mem_with_options(&data, LoadOptions { password: Some("user-pw".into()), ..Default::default() }).unwrap();
    assert!(opened.extract_text(&[1]).unwrap().contains("SECRET"));
    // Original untouched.
    assert!(!d.is_encrypted());
    assert!(encrypted_copy(&d, "", "").is_err());
}

#[test]
fn compressed_copy_is_smaller_and_equivalent() {
    let mut d = new_blank(612.0, 792.0).unwrap();
    for _ in 0..5 {
        watermark(&mut d, &spec("Repeated watermark text", Placement::Tiled, vec![])).unwrap();
    }
    let mut plain = Vec::new();
    d.save_to(&mut plain).unwrap();
    let small = compressed_bytes(&d).unwrap();
    assert!(small.len() < plain.len(), "{} >= {}", small.len(), plain.len());
    let back = PdfDoc::load_mem(&small).unwrap();
    assert!(back.extract_text(&[1]).unwrap().contains("Repeated"));
}

#[test]
fn attachments_are_listed_and_extracted() {
    let f = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/generated/F-10_attachments.pdf");
    let doc = PdfDoc::load(f).unwrap();
    let list = list_attachments(&doc);
    assert!(!list.is_empty(), "fixture declares an attachment");
    let bytes = attachment_bytes(&doc, 0).unwrap();
    assert!(!bytes.is_empty());
    assert!(list[0].size == 0 || list[0].size == bytes.len() as u64);
    assert!(attachment_bytes(&doc, 99).is_err());
    let _ = Object::Null;
}

#[test]
fn headers_footers_page_and_bates_numbers() {
    use stitchup_core::docops::{header_footer, HeaderFooterSpec, HfItem};
    let mut doc = stitchup_core::docops::new_blank(612.0, 792.0).unwrap();
    // Three pages; the second displayed rotated.
    for _ in 0..2 {
        stitchup_core::ops::insert_blank(&mut doc, 1, 612.0, 792.0).ok();
    }
    let pages = doc.get_pages();
    assert_eq!(pages.len(), 3);
    let p2 = pages[&2];
    let mut d2 = doc.get_object(p2).unwrap().as_dict().unwrap().clone();
    d2.set("Rotate", 90);
    doc.objects.insert(p2, lopdf::Object::Dictionary(d2));

    let item = |p: &str, t: &str| HfItem { position: p.into(), text: t.into() };
    let spec = HeaderFooterSpec {
        items: vec![item("tc", "Umowa — Łódź"), item("bc", "Page {page} of {pages}"), item("br", "{bates}")],
        size: 10.0, margin: 28.0, color: [0.0, 0.0, 0.0], family: "Helvetica".into(),
        start: 5, bates_prefix: "ABC".into(), bates_digits: 4, pages: vec![],
    };
    assert_eq!(header_footer(&mut doc, &spec).unwrap(), 3);
    let mut bytes = vec![];
    doc.save_to(&mut bytes).unwrap();
    let back = lopdf::Document::load_mem(&bytes).unwrap();
    let text = back.extract_text(&[1, 2, 3]).unwrap();
    for want in ["Page 5 of 7", "Page 7 of 7", "ABC0005", "ABC0007", "Umowa — Łódź"] {
        assert!(text.contains(want), "{want} in {text}");
    }
    // Positions: footer centred near the bottom of page 1; on the rotated page
    // the text runs along the displayed width (vertical in PDF space).
    let o1 = stitchup_core::objects::list(&back, 1).unwrap();
    let f1 = o1.iter().find(|o| o.text.contains("Page 5")).unwrap();
    let cx = (f1.rect[0] + f1.rect[2]) / 2.0;
    assert!((cx - 306.0).abs() < 2.0 && f1.rect[1] < 40.0, "{:?}", f1.rect);
    let o2 = stitchup_core::objects::list(&back, 2).unwrap();
    let f2 = o2.iter().find(|o| o.text.contains("Page 6")).unwrap();
    assert!(f2.rect[3] - f2.rect[1] > f2.rect[2] - f2.rect[0], "rotated with the page: {:?}", f2.rect);
}
