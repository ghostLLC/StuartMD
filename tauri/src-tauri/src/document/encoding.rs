use ::encoding::{all, DecoderTrap, EncoderTrap, Encoding};

fn codec(name: &str) -> Result<&'static dyn Encoding, String> {
    match name.to_ascii_lowercase().as_str() {
        "utf-8" => Ok(all::UTF_8),
        "utf-16le" => Ok(all::UTF_16LE),
        "utf-16be" => Ok(all::UTF_16BE),
        "gbk" => Ok(all::GBK),
        "gb18030" => Ok(all::GB18030),
        _ => Err(format!("不支持的文档编码: {name}")),
    }
}

pub fn bom_bytes(name: &str, bom: bool) -> Result<&'static [u8], String> {
    codec(name)?;
    if !bom { return Ok(&[]); }
    match name.to_ascii_lowercase().as_str() {
        "utf-8" => Ok(&[0xef, 0xbb, 0xbf]),
        "utf-16le" => Ok(&[0xff, 0xfe]),
        "utf-16be" => Ok(&[0xfe, 0xff]),
        _ => Err(format!("编码 {name} 不支持 BOM")),
    }
}

pub fn detect(bytes: &[u8]) -> Result<Option<(&'static str, bool, String)>, String> {
    for (prefix, name) in [(&[0xef, 0xbb, 0xbf][..], "utf-8"), (&[0xff, 0xfe][..], "utf-16le"), (&[0xfe, 0xff][..], "utf-16be")] {
        if bytes.starts_with(prefix) { return Ok(Some((name, true, decode(bytes, name, true)?))); }
    }
    match all::UTF_8.decode(bytes, DecoderTrap::Strict) {
        Ok(text) => Ok(Some(("utf-8", false, text))),
        Err(_) => Ok(None),
    }
}

pub fn decode(bytes: &[u8], name: &str, bom: bool) -> Result<String, String> {
    let prefix = bom_bytes(name, bom)?;
    if !bytes.starts_with(prefix) { return Err("文档 BOM 与所选编码不一致".into()); }
    codec(name)?.decode(&bytes[prefix.len()..], DecoderTrap::Strict).map_err(|error| format!("使用 {name} 严格读取失败: {error}"))
}

pub fn encode(text: &str, name: &str, bom: bool) -> Result<Vec<u8>, String> {
    let mut result = bom_bytes(name, bom)?.to_vec();
    let body = codec(name)?.encode(text, EncoderTrap::Strict).map_err(|error| {
        let unsupported = text.chars().enumerate().find(|(_, character)| codec(name).unwrap().encode(&character.to_string(), EncoderTrap::Strict).is_err());
        match unsupported {
            Some((offset, character)) => format!("字符 {character}（字符位置 {}）无法保存为 {name}: {error}", offset + 1),
            None => format!("使用 {name} 严格保存失败: {error}"),
        }
    })?;
    result.extend(body);
    Ok(result)
}

pub fn candidates(bytes: &[u8]) -> Vec<String> {
    ["gb18030", "gbk", "utf-16le", "utf-16be"].into_iter().filter(|name| decode(bytes, name, false).is_ok()).map(str::to_string).collect()
}

pub fn utf16_byte_offset(source: &str, offset: usize) -> Result<usize, String> {
    let mut units = 0;
    for (byte, character) in source.char_indices() {
        if units == offset { return Ok(byte); }
        units += character.len_utf16();
        if units > offset { return Err(format!("UTF-16 编辑位置 {offset} 切断了 Unicode 字符")); }
    }
    if units == offset { Ok(source.len()) } else { Err(format!("UTF-16 编辑位置 {offset} 超过文档长度")) }
}

pub fn apply_edits(source: &str, original_bytes: &[u8], original_encoding: &str, original_bom: bool, encoding: &str, bom: bool, edits: &[super::SourceEdit]) -> Result<(String, Vec<u8>), String> {
    let mut previous = 0;
    let mut text = String::new();
    let mut bytes = bom_bytes(encoding, bom)?.to_vec();
    let preserve = original_encoding == encoding && original_bom == bom;
    let original_prefix = bom_bytes(original_encoding, original_bom)?.len();
    let mut original_offset = original_prefix;
    let original_codec = codec(original_encoding)?;
    for edit in edits {
        let start = utf16_byte_offset(source, edit.from)?;
        let end = utf16_byte_offset(source, edit.to)?;
        if start < previous || end < start { return Err("编辑范围重复、未排序或结束位置早于起始位置".into()); }
        let untouched = &source[previous..start];
        let skipped = &source[start..end];
        text.push_str(untouched);
        text.push_str(&edit.inserted_text);
        let untouched_length = original_codec.encode(untouched, EncoderTrap::Strict).map_err(|error| error.to_string())?.len();
        let skipped_length = original_codec.encode(skipped, EncoderTrap::Strict).map_err(|error| error.to_string())?.len();
        if preserve {
            let original_end = original_offset.checked_add(untouched_length).ok_or("文档字节位置溢出")?;
            let slice = original_bytes.get(original_offset..original_end).ok_or("原始编码字节边界不一致")?;
            if original_codec.decode(slice, DecoderTrap::Strict).map_err(|error| error.to_string())? != untouched { return Err("原始字节与编辑范围不一致".into()); }
            bytes.extend_from_slice(slice);
        } else { bytes.extend(encode(untouched, encoding, false)?); }
        bytes.extend(encode(&edit.inserted_text, encoding, false)?);
        original_offset += untouched_length + skipped_length;
        previous = end;
    }
    let remaining = &source[previous..];
    text.push_str(remaining);
    if preserve {
        let tail = original_bytes.get(original_offset..).ok_or("原始编码字节边界不一致")?;
        if original_codec.decode(tail, DecoderTrap::Strict).map_err(|error| error.to_string())? != remaining { return Err("剩余原始字节与正文不一致".into()); }
        bytes.extend_from_slice(tail);
    } else { bytes.extend(encode(remaining, encoding, false)?); }
    Ok((text, bytes))
}
