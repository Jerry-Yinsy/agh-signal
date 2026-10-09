// 纯 Node 实现的 Markdown → Word(.docx) 转换器，不依赖 pandoc / Word / 网络。
// 支持：标题 1–4 级、段落、有序/无序列表、表格、围栏代码块、引用块、分隔线、行内粗体与行内代码。
// 用法：node tools/md2docx.mjs <输入.md> <输出.docx>
import { readFileSync, writeFileSync } from 'node:fs'

/* ---------------- ZIP（store 方式，无需外部依赖） ---------------- */

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { time, day }
}

function zip(entries) {
  const { time, day } = dosDateTime()
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuffer, data)

    const entryCentral = Buffer.alloc(46)
    entryCentral.writeUInt32LE(0x02014b50, 0)
    entryCentral.writeUInt16LE(20, 4)
    entryCentral.writeUInt16LE(20, 6)
    entryCentral.writeUInt16LE(0x0800, 8)
    entryCentral.writeUInt16LE(0, 10)
    entryCentral.writeUInt16LE(time, 12)
    entryCentral.writeUInt16LE(day, 14)
    entryCentral.writeUInt32LE(crc, 16)
    entryCentral.writeUInt32LE(data.length, 20)
    entryCentral.writeUInt32LE(data.length, 24)
    entryCentral.writeUInt16LE(nameBuffer.length, 28)
    entryCentral.writeUInt16LE(0, 30)
    entryCentral.writeUInt16LE(0, 32)
    entryCentral.writeUInt16LE(0, 34)
    entryCentral.writeUInt16LE(0, 36)
    entryCentral.writeUInt32LE(0, 38)
    entryCentral.writeUInt32LE(offset, 42)
    central.push(entryCentral, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuffer, end])
}

/* ---------------- Markdown 解析 ---------------- */

const escapeXml = (text) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 行内解析：粗体、行内代码、链接、斜体。返回 OOXML run 片段。 */
function inlineRuns(text) {
  const runs = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*]+\*)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) runs.push(run(escapeXml(text.slice(last, match.index))))
    const token = match[0]
    if (token.startsWith('`')) runs.push(run(escapeXml(token.slice(1, -1)), { code: true }))
    else if (token.startsWith('**')) runs.push(run(escapeXml(token.slice(2, -2)), { bold: true }))
    else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'))
      const target = token.slice(token.indexOf('](') + 2, -1)
      runs.push(run(escapeXml(label), { bold: false }))
      if (target && target !== label) runs.push(run(escapeXml(`（${target}）`), { small: true }))
    } else runs.push(run(escapeXml(token.slice(1, -1)), { italic: true }))
    last = match.index + token.length
  }
  if (last < text.length) runs.push(run(escapeXml(text.slice(last))))
  return runs.length ? runs.join('') : run('')
}

function run(text, options = {}) {
  const properties = []
  if (options.bold) properties.push('<w:b/>')
  if (options.italic) properties.push('<w:i/>')
  if (options.code) properties.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>')
  if (options.small) properties.push('<w:sz w:val="16"/><w:color w:val="666666"/>')
  const rPr = properties.length ? `<w:rPr>${properties.join('')}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

function paragraph(content, options = {}) {
  const style = options.style ? `<w:pStyle w:val="${options.style}"/>` : ''
  const indentation = options.indent ? `<w:ind w:left="${options.indent}"/>` : ''
  const spacing = options.spacing ? `<w:spacing ${options.spacing}/>` : ''
  const shading = options.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shading}"/>` : ''
  const properties = style || indentation || spacing || shading ? `<w:pPr>${style}${indentation}${spacing}${shading}</w:pPr>` : ''
  return `<w:p>${properties}${content}</w:p>`
}

/** 把一段 run 片段整体加粗，且不产生重复的 rPr。 */
function boldRuns(xml) {
  return xml
    .replace(/<w:r><w:rPr>/g, '<w:r><w:rPr><w:b/>')
    .replace(/<w:r>(?!<w:rPr>)/g, '<w:r><w:rPr><w:b/></w:rPr>')
}

function table(rows) {
  const columns = Math.max(...rows.map((row) => row.length))
  const totalWidth = 9000
  const columnWidth = Math.floor(totalWidth / columns)
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${columnWidth}"/>`).join('')
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders>'
  const body = rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: columns }, (_, columnIndex) => {
        const value = row[columnIndex] ?? ''
        const shade = rowIndex === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''
        // 表头加粗：合并进已有 rPr，避免出现重复的 <w:rPr>（那是 schema 非法、Word 会报文件损坏）
        const runs = rowIndex === 0 ? boldRuns(inlineRuns(value)) : inlineRuns(value)
        return (
          `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/>${shade}` +
          `<w:vAlign w:val="center"/></w:tcPr>` +
          `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${runs}</w:p></w:tc>`
        )
      }).join('')
      return `<w:tr>${cells}</w:tr>`
    })
    .join('')
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' +
    `<w:tblW w:w="${totalWidth}" w:type="dxa"/>${borders}` +
    '<w:tblLayout w:type="fixed"/></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>` +
    paragraph(run(''), { spacing: 'w:before="0" w:after="80"' })
  )
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim())
}

export function markdownToDocumentXml(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const body = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed === '') {
      index += 1
      continue
    }

    // 分页符（用于把多份文档合并成一本）
    if (/^<!--\s*pagebreak\s*-->$/iu.test(trimmed)) {
      body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`)
      index += 1
      continue
    }

    // 围栏代码块
    if (trimmed.startsWith('```')) {
      const buffer = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        buffer.push(lines[index])
        index += 1
      }
      index += 1
      for (const codeLine of buffer)
        body.push(
          paragraph(run(escapeXml(codeLine) || ' ', { code: true }), {
            style: 'Code',
            shading: 'F5F5F5',
          }),
        )
      body.push(paragraph(run(''), { spacing: 'w:after="60"' }))
      continue
    }

    // 表格
    if (trimmed.startsWith('|') && lines[index + 1]?.trim().match(/^\|[\s:|-]+\|$/u)) {
      const rows = [splitTableRow(trimmed)]
      index += 2
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index].trim()))
        index += 1
      }
      body.push(table(rows))
      continue
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/u.exec(trimmed)
    if (heading) {
      body.push(paragraph(inlineRuns(heading[2]), { style: `Heading${heading[1].length}` }))
      index += 1
      continue
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) {
      body.push(paragraph(run(''), { spacing: 'w:before="60" w:after="60"' }))
      index += 1
      continue
    }

    // 引用块
    if (trimmed.startsWith('>')) {
      const text = trimmed.replace(/^>\s?/u, '')
      body.push(paragraph(inlineRuns(text), { style: 'Quote' }))
      index += 1
      continue
    }

    // 列表
    const bullet = /^(\s*)([-*+])\s+(.*)$/u.exec(line)
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/u.exec(line)
    if (bullet || ordered) {
      const level = Math.floor((bullet?.[1] ?? ordered[1]).length / 2)
      const text = bullet ? bullet[3] : `${ordered[2]}. ${ordered[3]}`
      body.push(
        paragraph(inlineRuns(`${bullet ? '• ' : ''}${text}`), { indent: 360 + level * 360, spacing: 'w:before="20" w:after="20"' }),
      )
      index += 1
      continue
    }

    body.push(paragraph(inlineRuns(trimmed), { spacing: 'w:before="40" w:after="80"' }))
    index += 1
  }

  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/>' +
    '</w:sectPr>'
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}${section}</w:body></w:document>`
  )
}

/* ---------------- 组装 docx ---------------- */

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>
    <w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="34"/><w:color w:val="1F3864"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
    <w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="27"/><w:color w:val="2E5395"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
    <w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="2E5395"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/>
    <w:pPr><w:outlineLvl w:val="3"/><w:spacing w:before="140" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/>
    <w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="240"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="19"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>
    <w:pPr><w:ind w:left="360"/></w:pPr>
    <w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>
    <w:tblPr><w:tblBorders>
      <w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>
      <w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>
      <w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>
    </w:tblBorders></w:tblPr></w:style>
</w:styles>`

export function markdownToDocx(markdown) {
  const document = markdownToDocumentXml(markdown)
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: stylesXml },
    {
      name: 'docProps/core.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${escapeXml(process.argv[4] ?? 'agh-signal')}</dc:title>` +
        '<dc:creator>agh-signal</dc:creator>' +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/u, 'Z')}</dcterms:created>` +
        '</cp:coreProperties>',
    },
    {
      name: 'docProps/app.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        '<Application>agh-signal md2docx</Application></Properties>',
    },
  ])
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, '/').split('/').pop())) {
  const [, , input, output] = process.argv
  if (!input || !output) {
    console.error('用法: node tools/md2docx.mjs <输入.md> <输出.docx> [标题]')
    process.exit(2)
  }
  writeFileSync(output, markdownToDocx(readFileSync(input, 'utf8')))
  console.log(`已生成 ${output}`)
}
