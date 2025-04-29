export function filterContent(articleJson: any): any {
  // ads, footer, recommendations 등 불필요 요소 제거
  const { ads, footer, recommendations, ...cleaned } = articleJson;
  return cleaned;
}

export function jsonToMarkdown(json: any): string {
  let md = '';
  // 제목
  if (json.title) {
    md += `# ${json.title}\n\n`;
  }
  // 구조화된 섹션
  if (Array.isArray(json.sections)) {
    for (const section of json.sections) {
      if (section.heading) {
        md += `## ${section.heading}\n\n`;
      }
      if (section.content) {
        md += `${section.content}\n\n`;
      }
    }
  }
  // 이미지
  if (Array.isArray(json.images)) {
    for (const img of json.images) {
      md += `![${img.alt || ''}](${img.url})\n\n`;
    }
  }
  // 표
  if (Array.isArray(json.tables)) {
    for (const table of json.tables) {
      const header = table.header || [];
      const rows = table.rows || [];
      // 헤더
      md += `| ${header.join(' | ')} |\n`;
      md += `| ${header.map(() => '---').join(' | ')} |\n`;
      // 행
      for (const row of rows) {
        md += `| ${row.join(' | ')} |\n`;
      }
      md += `\n`;
    }
  }
  // 본문 단락
  if (typeof json.content === 'string') {
    md += `${json.content.trim()}\n\n`;
  }
  return md.trim();
} 