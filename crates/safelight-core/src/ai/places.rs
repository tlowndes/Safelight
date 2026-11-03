//! Places from the photo's GPS: read from the camera data (or a Google Takeout sidecar) and
//! looked up in a built-in list of about 145,000 towns. No map service is ever called.

use std::{path::Path, sync::OnceLock};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Place {
    pub lat: f64,
    pub lon: f64,
    /// Nearest town or city.
    pub town: Option<String>,
    /// County or district, then the wider region (e.g. "Greater London", "England").
    pub area: Option<String>,
    pub region: Option<String>,
    pub country: Option<String>,
}

/// Beyond this distance from the nearest town we only trust the country, and beyond the
/// second we name nothing (out at sea, or GPS nonsense).
const TOWN_KM: f64 = 40.0;
const COUNTRY_KM: f64 = 250.0;

/// GPS position from camera data, then from a Google Takeout sidecar.
pub fn gps(path: &Path) -> Option<(f64, f64)> {
    from_exif(path).or_else(|| from_takeout(path)).filter(|(lat, lon)| {
        lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0 && (lat.abs() > 1e-6 || lon.abs() > 1e-6)
    })
}

fn from_exif(path: &Path) -> Option<(f64, f64)> {
    let file = std::fs::File::open(path).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)).ok()?;
    let coord = |tag, ref_tag, neg: u8| -> Option<f64> {
        let f = ex.get_field(tag, exif::In::PRIMARY)?;
        let exif::Value::Rational(ref v) = f.value else { return None };
        let deg = v.first()?.to_f64() + v.get(1).map(|r| r.to_f64() / 60.0).unwrap_or(0.0) + v.get(2).map(|r| r.to_f64() / 3600.0).unwrap_or(0.0);
        let negative = ex
            .get_field(ref_tag, exif::In::PRIMARY)
            .and_then(|r| if let exif::Value::Ascii(ref a) = r.value { a.first().and_then(|s| s.first().copied()) } else { None })
            .map(|c| c.to_ascii_uppercase() == neg)
            .unwrap_or(false);
        Some(if negative { -deg } else { deg })
    };
    Some((coord(exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, b'S')?, coord(exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, b'W')?))
}

fn from_takeout(path: &Path) -> Option<(f64, f64)> {
    let v = crate::dates::takeout_sidecar(path)?;
    ["geoData", "geoDataExif"].iter().find_map(|k| {
        let (lat, lon) = (v[k]["latitude"].as_f64()?, v[k]["longitude"].as_f64()?);
        (lat != 0.0 || lon != 0.0).then_some((lat, lon))
    })
}

fn geocoder() -> &'static reverse_geocoder::ReverseGeocoder {
    static G: OnceLock<reverse_geocoder::ReverseGeocoder> = OnceLock::new();
    G.get_or_init(reverse_geocoder::ReverseGeocoder::new)
}

fn km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, la2) = (a.0.to_radians(), b.0.to_radians());
    let (dla, dlo) = ((b.0 - a.0).to_radians(), (b.1 - a.1).to_radians());
    let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
    6371.0 * 2.0 * h.sqrt().asin()
}

/// Name the place at a GPS position.
pub fn lookup(lat: f64, lon: f64) -> Place {
    let r = geocoder().search((lat, lon)).record;
    let d = km((lat, lon), (r.lat, r.lon));
    let some = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
    let near = d <= TOWN_KM;
    Place {
        lat,
        lon,
        town: if near { some(&r.name) } else { None },
        area: if near { some(&r.admin2) } else { None },
        region: if near { some(&r.admin1) } else { None },
        country: if d <= COUNTRY_KM { country_name(&r.cc).map(str::to_string).or_else(|| some(&r.cc)) } else { None },
    }
}

impl Place {
    /// Everything this place can be searched by, most specific first, without repeats.
    pub fn names(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for n in [&self.town, &self.area, &self.region, &self.country].into_iter().flatten() {
            if !out.iter().any(|o| o.eq_ignore_ascii_case(n)) {
                out.push(n.clone());
            }
        }
        out
    }

    /// "Brighton, England" style label.
    pub fn label(&self) -> Option<String> {
        let names = self.names();
        match (names.first(), names.last()) {
            (Some(a), Some(b)) if a != b => Some(format!("{a}, {b}")),
            (Some(a), _) => Some(a.clone()),
            _ => None,
        }
    }
}

pub fn country_name(cc: &str) -> Option<&'static str> {
    COUNTRIES.split('|').find_map(|e| e.split_once(':').filter(|(c, _)| c.eq_ignore_ascii_case(cc)).map(|(_, n)| n))
}

const COUNTRIES: &str = "AD:Andorra|AE:United Arab Emirates|AF:Afghanistan|AG:Antigua and Barbuda|AI:Anguilla|AL:Albania|AM:Armenia|AO:Angola|AQ:Antarctica|AR:Argentina|AS:American Samoa|AT:Austria|AU:Australia|AW:Aruba|AX:Åland|AZ:Azerbaijan|BA:Bosnia and Herzegovina|BB:Barbados|BD:Bangladesh|BE:Belgium|BF:Burkina Faso|BG:Bulgaria|BH:Bahrain|BI:Burundi|BJ:Benin|BL:Saint Barthélemy|BM:Bermuda|BN:Brunei|BO:Bolivia|BQ:Caribbean Netherlands|BR:Brazil|BS:Bahamas|BT:Bhutan|BW:Botswana|BY:Belarus|BZ:Belize|CA:Canada|CC:Cocos Islands|CD:DR Congo|CF:Central African Republic|CG:Congo|CH:Switzerland|CI:Côte d'Ivoire|CK:Cook Islands|CL:Chile|CM:Cameroon|CN:China|CO:Colombia|CR:Costa Rica|CU:Cuba|CV:Cape Verde|CW:Curaçao|CX:Christmas Island|CY:Cyprus|CZ:Czechia|DE:Germany|DJ:Djibouti|DK:Denmark|DM:Dominica|DO:Dominican Republic|DZ:Algeria|EC:Ecuador|EE:Estonia|EG:Egypt|EH:Western Sahara|ER:Eritrea|ES:Spain|ET:Ethiopia|FI:Finland|FJ:Fiji|FK:Falkland Islands|FM:Micronesia|FO:Faroe Islands|FR:France|GA:Gabon|GB:United Kingdom|GD:Grenada|GE:Georgia|GF:French Guiana|GG:Guernsey|GH:Ghana|GI:Gibraltar|GL:Greenland|GM:Gambia|GN:Guinea|GP:Guadeloupe|GQ:Equatorial Guinea|GR:Greece|GT:Guatemala|GU:Guam|GW:Guinea-Bissau|GY:Guyana|HK:Hong Kong|HN:Honduras|HR:Croatia|HT:Haiti|HU:Hungary|ID:Indonesia|IE:Ireland|IL:Israel|IM:Isle of Man|IN:India|IQ:Iraq|IR:Iran|IS:Iceland|IT:Italy|JE:Jersey|JM:Jamaica|JO:Jordan|JP:Japan|KE:Kenya|KG:Kyrgyzstan|KH:Cambodia|KI:Kiribati|KM:Comoros|KN:Saint Kitts and Nevis|KP:North Korea|KR:South Korea|KW:Kuwait|KY:Cayman Islands|KZ:Kazakhstan|LA:Laos|LB:Lebanon|LC:Saint Lucia|LI:Liechtenstein|LK:Sri Lanka|LR:Liberia|LS:Lesotho|LT:Lithuania|LU:Luxembourg|LV:Latvia|LY:Libya|MA:Morocco|MC:Monaco|MD:Moldova|ME:Montenegro|MF:Saint Martin|MG:Madagascar|MH:Marshall Islands|MK:North Macedonia|ML:Mali|MM:Myanmar|MN:Mongolia|MO:Macao|MP:Northern Mariana Islands|MQ:Martinique|MR:Mauritania|MS:Montserrat|MT:Malta|MU:Mauritius|MV:Maldives|MW:Malawi|MX:Mexico|MY:Malaysia|MZ:Mozambique|NA:Namibia|NC:New Caledonia|NE:Niger|NF:Norfolk Island|NG:Nigeria|NI:Nicaragua|NL:Netherlands|NO:Norway|NP:Nepal|NR:Nauru|NU:Niue|NZ:New Zealand|OM:Oman|PA:Panama|PE:Peru|PF:French Polynesia|PG:Papua New Guinea|PH:Philippines|PK:Pakistan|PL:Poland|PM:Saint Pierre and Miquelon|PN:Pitcairn Islands|PR:Puerto Rico|PS:Palestine|PT:Portugal|PW:Palau|PY:Paraguay|QA:Qatar|RE:Réunion|RO:Romania|RS:Serbia|RU:Russia|RW:Rwanda|SA:Saudi Arabia|SB:Solomon Islands|SC:Seychelles|SD:Sudan|SE:Sweden|SG:Singapore|SH:Saint Helena|SI:Slovenia|SJ:Svalbard and Jan Mayen|SK:Slovakia|SL:Sierra Leone|SM:San Marino|SN:Senegal|SO:Somalia|SR:Suriname|SS:South Sudan|ST:São Tomé and Príncipe|SV:El Salvador|SX:Sint Maarten|SY:Syria|SZ:Eswatini|TC:Turks and Caicos Islands|TD:Chad|TG:Togo|TH:Thailand|TJ:Tajikistan|TK:Tokelau|TL:Timor-Leste|TM:Turkmenistan|TN:Tunisia|TO:Tonga|TR:Türkiye|TT:Trinidad and Tobago|TV:Tuvalu|TW:Taiwan|TZ:Tanzania|UA:Ukraine|UG:Uganda|US:United States|UY:Uruguay|UZ:Uzbekistan|VA:Vatican City|VC:Saint Vincent and the Grenadines|VE:Venezuela|VG:British Virgin Islands|VI:US Virgin Islands|VN:Vietnam|VU:Vanuatu|WF:Wallis and Futuna|WS:Samoa|XK:Kosovo|YE:Yemen|YT:Mayotte|ZA:South Africa|ZM:Zambia|ZW:Zimbabwe";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_places_from_gps() {
        let brighton = lookup(50.8225, -0.1372);
        assert_eq!(brighton.country.as_deref(), Some("United Kingdom"));
        assert!(brighton.names().iter().any(|n| n.contains("Brighton") || n.contains("Hove")), "{brighton:?}");
        let paris = lookup(48.8584, 2.2945);
        assert_eq!(paris.country.as_deref(), Some("France"));
        // Middle of the Atlantic: no town, no country.
        let sea = lookup(35.0, -40.0);
        assert_eq!((sea.town, sea.country), (None, None));
    }

    #[test]
    fn reads_takeout_gps() {
        let dir = tempfile::tempdir().unwrap();
        let photo = dir.path().join("IMG_1.jpg");
        std::fs::write(&photo, b"not really a jpeg").unwrap();
        std::fs::write(dir.path().join("IMG_1.jpg.json"), r#"{"geoData":{"latitude":51.5007,"longitude":-0.1246}}"#).unwrap();
        assert_eq!(gps(&photo), Some((51.5007, -0.1246)));
        std::fs::write(dir.path().join("IMG_1.jpg.json"), r#"{"geoData":{"latitude":0.0,"longitude":0.0}}"#).unwrap();
        assert_eq!(gps(&photo), None);
    }
}
