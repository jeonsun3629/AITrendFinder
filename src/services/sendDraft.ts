import axios from 'axios';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';

dotenv.config();

// URL 유효성 검사 함수
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Notion 클라이언트 설정
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

/**
 * 텍스트를 일정 길이로 제한
 */
function truncateText(text: string | undefined, maxLength: number = 2000): string {
  if (!text) return '';
  
  // 객체인 경우 문자열로 변환 시도
  if (typeof text === 'object') {
    try {
      text = JSON.stringify(text);
    } catch (e) {
      text = String(text);
    }
  }
  
  return text?.substring(0, maxLength) || '';
}

/**
 * 배열에서 유효한 URL을 찾아 반환
 */
function getValidUrlFromArray(urls: any[] | undefined, defaultUrl: string): string {
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return defaultUrl;
  }
  
  for (const url of urls) {
    const urlStr = typeof url === 'string' ? url : '';
    if (isValidUrl(urlStr)) {
      return urlStr;
    }
  }
  
  return defaultUrl;
}

/**
 * Notion용 리치 텍스트 형식으로 변환
 */
function createRichText(content: string | any): { text: { content: string } }[] {
  // 내용이 없거나 최대 크기를 초과하는 경우 처리
  if (!content) return [{ text: { content: '' } }];
  
  // 객체인 경우 문자열로 변환 시도
  if (typeof content === 'object') {
    try {
      content = JSON.stringify(content);
    } catch (e) {
      content = String(content);
    }
  }
  
  // 문자열이 아닌 경우 변환
  if (typeof content !== 'string') {
    content = String(content);
  }
  
  // 노션 API 텍스트 제한 (2000자)
  const truncated = truncateText(content);
  return [{ text: { content: truncated } }];
}

/**
 * Notion 블록을 생성합니다
 */
function createParagraphBlock(content: string, link?: string): BlockObjectRequest {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { 
            content,
            link: link ? { url: link } : null
          },
        }
      ],
    }
  };
}

async function sendDraftToDiscord(draft_post: string) {
  try {
    const response = await axios.post(
      process.env.DISCORD_WEBHOOK_URL || '',
      {
        content: draft_post,
        flags: 4 // SUPPRESS_EMBEDS
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    return `Success sending draft to Discord webhook at ${new Date().toISOString()}`;
  } catch (error) {
    console.log('Error sending draft to Discord webhook');
    console.error(error);
    throw error;
  }
}

async function sendDraftToSlack(draft_post: string) {
  try {
    const response = await axios.post(
      process.env.SLACK_WEBHOOK_URL || '',
      {
        text: draft_post,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    return `Success sending draft to webhook at ${new Date().toISOString()}`;
  } catch (error) {
    console.log('error sending draft to webhook');
    console.log(error);
  }
}

async function sendDraftToNotion(draft: { draft_post: string, translatedContent: any[] }) {
  try {
    // 스토리를 파싱하여 각 항목을 분리
    const titleMatch = draft.draft_post.match(/🚀 AI 및 LLM 트렌드 \((.*?)\)\n\n/);
    const title = titleMatch ? titleMatch[1] : new Date().toLocaleDateString();
    
    // 번역된 콘텐츠 항목들 사용
    for (const item of draft.translatedContent) {
      if (!item.translated && !item.original) continue;
      
      // 블록 생성
      const blocks: BlockObjectRequest[] = [];
      
      // 번역된 내용 추가
      blocks.push(createParagraphBlock(item.translated || item.original));
      
      // 원문이 있고 번역도 있는 경우 원문도 추가
      if (item.original && item.translated) {
        blocks.push(createParagraphBlock('원문: ' + item.original));
      }
      
      // 링크 추가
      blocks.push(createParagraphBlock(item.link || '', item.link));
      
      await notion.pages.create({
        parent: {
          database_id: process.env.NOTION_DATABASE_ID || '',
        },
        properties: {
          Title: {
            title: [
              {
                text: {
                  content: typeof item.title_ko === 'string' 
                    ? item.title_ko 
                    : typeof item.title_ko === 'object' && item.title_ko?.text 
                      ? String(item.title_ko.text) 
                      : typeof item.translated === 'string' 
                        ? item.translated 
                        : String(item.original || '무제'),
                },
              },
            ],
          },
          Date: {
            date: {
              start: new Date().toISOString().split('T')[0],
            },
          },
          Content_kr: {
            rich_text: createRichText(item.description_ko || '')
          },
          URL: {
            url: item.link || null,
          },
          Category: {
            select: {
              name: getCategoryFromContent(item.category, item.translated || item.original)
            }
          },
          Content_full: {
            rich_text: createRichText(truncateText(item.content_full))
          },
          Content_full_kr: {
            rich_text: createRichText(truncateText(item.content_full_kr))
          },
          Image_URL: {
            url: getValidUrlFromArray(item.image_url, "https://example.com/placeholder-image.jpg")
          },
          Video_URL: {
            url: getValidUrlFromArray(item.video_url, "https://example.com/placeholder-video.mp4")
          }
        },
        children: blocks,
      });
    }

    return `Success sending ${draft.translatedContent.length} trends to Notion at ${new Date().toISOString()}`;
  } catch (error) {
    console.log('Error sending draft to Notion');
    console.error(error);
    throw error;
  }
}

/**
 * 내용을 분석하여 적절한 카테고리를 반환합니다.
 * @param existingCategory 이미 설정된 카테고리 (있는 경우)
 * @param content 포스트 내용
 * @returns 유효한 카테고리 (모델 업데이트, 연구 동향, 시장 동향, 개발자 도구 중 하나)
 */
function getCategoryFromContent(existingCategory: string | undefined, content: string): string {
  // 유효한 카테고리 목록
  const validCategories = ['모델 업데이트', '연구 동향', '시장 동향', '개발자 도구'];
  
  // 이미 유효한 카테고리가 있으면 그대로 사용
  if (existingCategory && validCategories.includes(existingCategory)) {
    return existingCategory;
  }
  
  // 내용에 기반한 키워드 분류
  const contentLower = content.toLowerCase();
  
  // 카테고리별 키워드
  const categoryKeywords = {
    '모델 업데이트': ['gpt-', 'llama', 'claude', 'gemini', '모델 출시', '업데이트', '버전', '릴리스', '새로운 모델', '모델 개선', 'llm'],
    '연구 동향': ['논문', '연구', '발표', '학습', '알고리즘', '성능', '향상', '연구팀', '발견', '혁신'],
    '시장 동향': ['시장', '투자', '인수', '합병', '성장', '전망', '매출', '기업', '수익', '사업', '협력', '파트너십'],
    '개발자 도구': ['api', '도구', '플랫폼', '개발', '코드', '라이브러리', '프레임워크', 'sdk', '오픈소스', '개발자']
  };
  
  // 각 카테고리별 점수 계산
  const scores: Record<string, number> = {};
  
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    scores[category] = 0;
    for (const keyword of keywords) {
      const regex = new RegExp(keyword, 'gi');
      const matches = contentLower.match(regex);
      if (matches) {
        scores[category] += matches.length;
      }
    }
  }
  
  // 가장 높은 점수의 카테고리 찾기
  let bestCategory = '연구 동향'; // 기본값
  let maxScore = 0;
  
  for (const [category, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestCategory = category;
    }
  }
  
  return bestCategory;
}

export async function sendDraft(draft: { draft_post: string, translatedContent: any[] } | string) {
  const notificationDriver = process.env.NOTIFICATION_DRIVER?.toLowerCase();

  // 문자열로 들어오는 경우 (이전 코드와의 호환성을 위해)
  const draft_post = typeof draft === 'string' ? draft : draft.draft_post;

  switch (notificationDriver) {
    case 'slack':
      return sendDraftToSlack(draft_post);
    case 'discord':
      return sendDraftToDiscord(draft_post);
    case 'notion':
      return sendDraftToNotion(typeof draft === 'string' ? { draft_post, translatedContent: [] } : draft);
    default:
      throw new Error(`Unsupported notification driver: ${notificationDriver}`);
  }
}