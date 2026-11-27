//! 画像サムネイル（`image` でデコード → 縮小 → WebP 品質 75）。

use std::path::Path;

use image::{DynamicImage, ImageDecoder, ImageReader, Rgba, RgbaImage};

use super::ThumbError;

/// 画像を読み込む。EXIF の向き（Orientation）も適用する。
pub fn load(path: &Path) -> Result<DynamicImage, ThumbError> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    // EXIF が無い・非対応の形式では `NoTransforms` が返る
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// `DynamicImage` を長辺 `max_edge` に縮小して WebP にする。
///
/// 元が小さければ拡大しない（`thumbnail` は縮小専用）。透過はそのまま保持する。
pub fn encode_webp(
    image: &DynamicImage,
    max_edge: u32,
    quality: f32,
) -> Result<Vec<u8>, ThumbError> {
    let resized = if image.width().max(image.height()) > max_edge {
        image.thumbnail(max_edge, max_edge)
    } else {
        image.clone()
    };
    Ok(encode_rgba(&resized.to_rgba8(), quality))
}

fn encode_rgba(image: &RgbaImage, quality: f32) -> Vec<u8> {
    let encoder = webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height());
    encoder.encode(quality).to_vec()
}

/// 画像ファイル → WebP バイト列。
pub fn thumbnail(path: &Path, max_edge: u32, quality: f32) -> Result<Vec<u8>, ThumbError> {
    let image = load(path)?;
    encode_webp(&image, max_edge, quality)
}

/// 生成に失敗したファイル用のプレースホルダ（控えめな「画像」アイコン）。
pub fn placeholder(max_edge: u32, quality: f32) -> Result<Vec<u8>, ThumbError> {
    let size = max_edge.clamp(64, 256);
    let mut canvas = RgbaImage::from_pixel(size, size, Rgba([26, 26, 32, 255]));
    let unit = size as f32;

    // 枠
    let inset = (unit * 0.16) as u32;
    let border = Rgba([58, 58, 70, 255]);
    for x in inset..size.saturating_sub(inset) {
        canvas.put_pixel(x, inset, border);
        canvas.put_pixel(x, size - inset - 1, border);
    }
    for y in inset..size.saturating_sub(inset) {
        canvas.put_pixel(inset, y, border);
        canvas.put_pixel(size - inset - 1, y, border);
    }

    // 山（三角形）と太陽（円）
    fill_triangle(
        &mut canvas,
        (unit * 0.24, unit * 0.72),
        (unit * 0.50, unit * 0.42),
        (unit * 0.76, unit * 0.72),
        Rgba([74, 74, 90, 255]),
    );
    fill_circle(
        &mut canvas,
        unit * 0.66,
        unit * 0.36,
        unit * 0.07,
        Rgba([96, 96, 118, 255]),
    );

    Ok(encode_rgba(&canvas, quality))
}

fn fill_triangle(
    image: &mut RgbaImage,
    a: (f32, f32),
    b: (f32, f32),
    c: (f32, f32),
    color: Rgba<u8>,
) {
    let width = image.width() as i32;
    let height = image.height() as i32;
    let min_x = a.0.min(b.0).min(c.0).floor().max(0.0) as i32;
    let max_x = a.0.max(b.0).max(c.0).ceil().min(width as f32 - 1.0) as i32;
    let min_y = a.1.min(b.1).min(c.1).floor().max(0.0) as i32;
    let max_y = a.1.max(b.1).max(c.1).ceil().min(height as f32 - 1.0) as i32;

    let sign = |p1: (f32, f32), p2: (f32, f32), p3: (f32, f32)| {
        (p1.0 - p3.0) * (p2.1 - p3.1) - (p2.0 - p3.0) * (p1.1 - p3.1)
    };

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let p = (x as f32 + 0.5, y as f32 + 0.5);
            let d1 = sign(p, a, b);
            let d2 = sign(p, b, c);
            let d3 = sign(p, c, a);
            let has_negative = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
            let has_positive = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
            if !(has_negative && has_positive) {
                image.put_pixel(x as u32, y as u32, color);
            }
        }
    }
}

fn fill_circle(image: &mut RgbaImage, cx: f32, cy: f32, radius: f32, color: Rgba<u8>) {
    let width = image.width() as i32;
    let height = image.height() as i32;
    let min_x = (cx - radius).floor().max(0.0) as i32;
    let max_x = (cx + radius).ceil().min(width as f32 - 1.0) as i32;
    let min_y = (cy - radius).floor().max(0.0) as i32;
    let max_y = (cy + radius).ceil().min(height as f32 - 1.0) as i32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            if dx * dx + dy * dy <= radius * radius {
                image.put_pixel(x as u32, y as u32, color);
            }
        }
    }
}
