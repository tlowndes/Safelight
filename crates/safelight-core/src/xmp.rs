//! XMP sidecars: a small `.xmp` file next to a photo holding its rating, colour label, caption,
//! copyright and edits, so Lightroom, Bridge, darktable and others can read them. Safelight
//! only writes these when asked; the photo itself is never changed.

use crate::{catalogue::Catalogue, develop, meta, Result};
use std::path::{Path, PathBuf};

/// `IMG_1234.CR3` → `IMG_1234.xmp`, the name Lightroom and Bridge look for.
pub fn sidecar_path(photo: &Path) -> PathBuf {
    photo.with_extension("xmp")
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn label_name(l: &str) -> &'static str {
    match l {
        "red" => "Red",
        "yellow" => "Yellow",
        "green" => "Green",
        "blue" => "Blue",
        "purple" => "Purple",
        _ => "",
    }
}

/// The sidecar's text. Rejected photos get rating -1, as Lightroom does.
pub fn render(rating: i64, flag: i64, label: Option<&str>, d: &meta::Details, e: &develop::Edits) -> String {
    let rating = if flag == -1 { -1 } else { rating };
    let mut attrs = vec![format!("xmp:Rating=\"{rating}\""), "xmp:CreatorTool=\"Safelight\"".into()];
    if let Some(l) = label.map(label_name).filter(|l| !l.is_empty()) {
        attrs.push(format!("xmp:Label=\"{l}\""));
    }
    let crs = [
        ("Exposure2012", format!("{:+.2}", e.exposure)),
        ("Contrast2012", format!("{:+.0}", e.contrast)),
        ("Highlights2012", format!("{:+.0}", e.highlights)),
        ("Shadows2012", format!("{:+.0}", e.shadows)),
        ("Whites2012", format!("{:+.0}", e.whites)),
        ("Blacks2012", format!("{:+.0}", e.blacks)),
        ("Clarity2012", format!("{:+.0}", e.clarity)),
        ("Dehaze", format!("{:+.0}", e.dehaze)),
        ("Vibrance", format!("{:+.0}", e.vibrance)),
        ("Saturation", format!("{:+.0}", e.saturation)),
        ("IncrementalTemperature", format!("{:+.0}", e.temperature)),
        ("IncrementalTint", format!("{:+.0}", e.tint)),
        ("Sharpness", format!("{:.0}", e.sharpening)),
        ("LuminanceSmoothing", format!("{:.0}", e.noise)),
        ("PostCropVignetteAmount", format!("{:+.0}", e.vignette)),
    ];
    if !develop::is_default(e) {
        attrs.push("crs:HasSettings=\"True\"".into());
        attrs.extend(crs.iter().map(|(k, v)| format!("crs:{k}=\"{v}\"")));
    }
    let alt = |tag: &str, v: &str| {
        if v.trim().is_empty() {
            String::new()
        } else {
            format!("   <dc:{tag}><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:{tag}>\n", esc(v.trim()))
        }
    };
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n    xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n    xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n    {}>\n{}{}  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n",
        attrs.join("\n    "),
        alt("description", &d.caption),
        alt("rights", &d.copyright),
    )
}

#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct XmpReport {
    pub written: usize,
    pub errors: Vec<String>,
}

/// Write a sidecar for each photo, replacing one Safelight wrote before. A sidecar written by
/// another app is left alone unless `overwrite_others` is set.
pub fn write_sidecars(cat: &Catalogue, ids: &[i64], overwrite_others: bool) -> Result<XmpReport> {
    let mut r = XmpReport::default();
    for &id in ids {
        let Some(item) = cat.item(id)? else { continue };
        let dest = sidecar_path(Path::new(&item.path));
        if !overwrite_others && dest.exists() {
            let theirs = std::fs::read_to_string(&dest).map(|t| !t.contains("xmp:CreatorTool=\"Safelight\"")).unwrap_or(true);
            if theirs {
                r.errors.push(format!("{}: another app's XMP file is already there", dest.display()));
                continue;
            }
        }
        let text = render(item.rating, item.flag, item.label.as_deref(), &meta::details(cat, id)?, &develop::load_edits(cat, id)?);
        match std::fs::write(&dest, text) {
            Ok(()) => r.written += 1,
            Err(e) => r.errors.push(format!("{}: {e}", dest.display())),
        }
    }
    Ok(r)
}

/// Rating and label from an existing sidecar (any app's), for bringing them in.
pub fn read_sidecar(photo: &Path) -> Option<(i64, Option<String>)> {
    let t = std::fs::read_to_string(sidecar_path(photo)).ok()?;
    let attr = |name: &str| {
        let i = t.find(&format!("{name}=\""))? + name.len() + 2;
        Some(t[i..].split('"').next()?.to_string())
    };
    let rating = attr("xmp:Rating").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let label = attr("xmp:Label").map(|l| l.to_lowercase()).filter(|l| crate::catalogue::LABELS.contains(&l.as_str()));
    Some((rating, label))
}

/// Bring ratings and labels in from sidecars other apps wrote. Returns how many photos changed.
pub fn read_sidecars(cat: &Catalogue, ids: &[i64]) -> Result<usize> {
    let mut changed = 0;
    for &id in ids {
        let Some(item) = cat.item(id)? else { continue };
        let Some((rating, label)) = read_sidecar(Path::new(&item.path)) else { continue };
        if rating < 0 {
            cat.set_flag(&[id], -1)?;
        } else {
            cat.set_rating(&[id], rating)?;
        }
        if label.is_some() {
            cat.set_label(&[id], label.as_deref())?;
        }
        changed += 1;
    }
    Ok(changed)
}
