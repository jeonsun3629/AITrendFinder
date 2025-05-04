import axios from 'axios';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { retrieveFullContent } from './contentStorage';

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
 * 원문 내용 가져오기 (Supabase 또는 item.content_full 사용)
 */
async function getFullContent(item: any): Promise<string> {
  // 로깅을 위한 식별자
  const itemIdentifier = item.title_ko || item.title || item.link || 'unknown';
  
  // 우선 Supabase에서 가져오기 시도 - 가능한 모든 ID 사용
  try {
    // content_storage_id나 story_id가 있으면 시도
    if (item.content_storage_id || item.story_id) {
      const storageId = item.content_storage_id || item.story_id;
      console.log(`Supabase에서 원문 가져오기 시도: ${itemIdentifier} (ID: ${storageId})`);
      
      try {
        const fullContent = await retrieveFullContent(storageId);
        if (fullContent) {
          console.log(`Supabase에서 전체 원문을 가져왔습니다 (${fullContent.length} 바이트)`);
          return fullContent;
        }
      } catch (storageError) {
        console.error(`Supabase 원문 가져오기 실패 (ID: ${storageId}):`, storageError);
      }
    } else {
      console.log(`${itemIdentifier}: Supabase 저장 ID가 없습니다.`);
    }
  } catch (error) {
    console.error(`Supabase에서 원문 가져오기 실패 (${itemIdentifier}):`, error);
  }
  
  // item.content_full 확인
  if (item.content_full) {
    console.log(`${itemIdentifier}: 기존 content_full 사용 (${item.content_full.length} 바이트)`);
    return item.content_full;
  }
  
  // item.original 확인
  if (item.original) {
    console.log(`${itemIdentifier}: original 내용 사용 (${item.original.length} 바이트)`);
    return item.original;
  }
  
  // 모든 것이 실패한 경우 빈 문자열 반환
  console.log(`${itemIdentifier}: 사용 가능한 콘텐츠를 찾지 못했습니다.`);
  return '';
}

/**
 * Notion용 리치 텍스트 형식으로 변환
 */
function createRichText(content: string | any): { text: { content: string } }[] {
  // 내용이 없는 경우 처리
  if (!content) return [{ text: { content: '' } }];
  
  // 문자열로 변환 시도
  let textContent = '';
  
  try {
    if (typeof content === 'object') {
      // JSON 객체인 경우 문자열로 변환
      textContent = JSON.stringify(content);
    } else if (typeof content === 'string') {
      // 이미 문자열인 경우 그대로 사용
      textContent = content;
    } else {
      // 기타 타입인 경우 String 생성자로 변환
      textContent = String(content);
    }
  } catch (error) {
    console.error('Rich text 변환 오류:', error);
    // 오류 발생 시 안전하게 빈 문자열 사용
    textContent = String(content) || '';
  }
  
  // 특수 문자나 이스케이프 문자로 인한 JSON 파싱 오류 방지
  try {
    // 역슬래시나 따옴표 같은 특수 문자 처리
    textContent = textContent.replace(/\\"/g, '"')
                             .replace(/\\\\/g, '\\')
                             .replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // 제어 문자 제거
  } catch (e) {
    console.error('문자열 정리 중 오류:', e);
  }
  
  // 노션 API 텍스트 제한 (2000자)
  const truncated = truncateText(textContent);
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
    
    // Notion 데이터베이스 스키마 확인 시도
    try {
      const databaseId = process.env.NOTION_DATABASE_ID || '';
      console.log(`Notion 데이터베이스 확인 시도 (ID: ${databaseId})`);
      
      const { properties } = await notion.databases.retrieve({
        database_id: databaseId
      });
      
      console.log('Notion 데이터베이스 필드 목록:');
      Object.keys(properties).forEach(propertyName => {
        console.log(`- ${propertyName} (${properties[propertyName].type})`);
      });
    } catch (schemaError) {
      console.error('Notion 데이터베이스 스키마 확인 실패:', schemaError);
    }
    
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
      
      // 노션에 페이지 생성 요청 전 로깅
      console.log(`Notion에 페이지 생성 중: ${typeof item.title_ko === 'string' ? item.title_ko : '무제'}`);
      
      // 실제 전송될 항목의 요약 정보 로깅
      console.log(`Summary_ko 내용 길이: ${(item.summary_ko || '').length}바이트`);
      console.log(`content_full_kr 내용 길이: ${(item.content_full_kr || '').length}바이트`);
      
      // 한국 시간(KST)으로 현재 날짜 생성
      const koreaTime = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
      const koreaDateStr = koreaTime.toISOString().split('T')[0];
      console.log(`현재 한국 날짜로 설정: ${koreaDateStr}`);
      
      try {
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
                start: koreaDateStr,
              },
            },
            Summary_kr: {
              rich_text: createRichText(item.summary_ko || '')
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
              rich_text: createRichText(truncateText(await getFullContent(item)))
            },
            Content_full_kr: {
              rich_text: createRichText(truncateText(item.content_full_kr || item.translated || ''))
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
        
        console.log(`페이지 생성 성공: ${typeof item.title_ko === 'string' ? item.title_ko : '무제'}`);
      } catch (pageError) {
        console.error('Notion 페이지 생성 실패:', pageError);
        console.error('오류 발생한 항목:', JSON.stringify({
          title: item.title_ko,
          summary: (item.summary_ko || '').substring(0, 50) + '...',
          link: item.link
        }));
        throw pageError;
      }
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
export function getCategoryFromContent(existingCategory: string | undefined, content: string): string {
  // 유효한 카테고리 목록
  const validCategories = ['모델 업데이트', '연구 동향', '시장 동향', '개발자 도구'];
  
  // 이미 유효한 카테고리가 있으면 그대로 사용
  if (existingCategory && validCategories.includes(existingCategory)) {
    return existingCategory;
  }
  
  // 내용에 기반한 키워드 분류
  const contentLower = content.toLowerCase();
  
  // 카테고리별 키워드 (세분화)
  const categoryKeywords = {
    '모델 업데이트': [
      'gpt-', 'llama', 'claude', 'gemini', 'mistral', 'mixtral', 'palmyra', 'phi', 'falcon',
      '모델 출시', '업데이트', '버전', '릴리스', '새로운 모델', '모델 개선', 'llm', 'fine-tuning', 
      'fine tuned', '파인튜닝', '파라미터', 'parameter', '학습 데이터', 'training data',
      'foundation model', '기반 모델', '대형 언어 모델', 'large language model', '생성형 AI',
      'generative ai', '베이스 모델', 'base model', '앙상블', 'ensemble', '토크나이저', 'tokenizer',
      'context length', '컨텍스트 길이', '컨텍스트 윈도우', 'context window'
    ],
    '연구 동향': [
      '논문', '연구', '발표', '학습', '알고리즘', '성능', '향상', '연구팀', '발견', '혁신',
      'arxiv', 'research', 'paper', 'study', 'academic', '학술', 'benchmark', '벤치마크',
      'sota', 'state-of-the-art', 'state of the art', '최신 기술', '최신 연구', '최신 논문',
      'novel', '새로운 방법', '새로운 접근', 'method', 'approach', '접근법', '방법론', 'methodology',
      'architecture', '아키텍처', 'neural', '뉴럴', 'transformer', '트랜스포머', 'attention', '어텐션',
      'diffusion', '디퓨전', 'gan', 'generative adversarial', 'reinforcement learning', '강화학습',
      'self-supervised', 'self supervised', '자기지도학습', 'multimodal', '멀티모달', '다중모달'
    ],
    '시장 동향': [
      '시장', '투자', '인수', '합병', '성장', '전망', '매출', '기업', '수익', '사업', '협력', '파트너십',
      'funding', '펀딩', 'series', '시리즈', 'valuation', '기업가치', 'ipo', '상장', 'stock', '주식',
      'market share', '시장 점유율', 'market cap', '시가총액', 'revenue', 'profit', '이익', 'loss', '손실',
      'startup', '스타트업', 'venture', '벤처', 'capital', '캐피탈', 'acquisition', 'merger', 
      'partnership', 'deal', '계약', '협약', 'alliance', '제휴', 'industry', '산업', 'sector', '섹터',
      'commercial', '상업적', 'launch', '출시', 'product', '제품', 'service', '서비스', 'customer', '고객'
    ],
    '개발자 도구': [
      'api', '도구', '플랫폼', '개발', '코드', '라이브러리', '프레임워크', 'sdk', '오픈소스', '개발자',
      'tool', 'github', 'repository', '레포지토리', 'package', '패키지', 'developer', 'integration', '통합',
      'plugin', '플러그인', 'extension', '확장', 'addon', '애드온', 'interface', '인터페이스', 'cli', 
      'command line', '명령줄', 'terminal', '터미널', 'ide', 'environment', '환경', 'debug', '디버그',
      'deployment', '배포', 'release', 'open source', '오픈소스', 'documentation', '문서화', 'tutorial',
      '튜토리얼', 'guide', '가이드', 'features', '기능', 'ui', 'user interface', '사용자 인터페이스',
      'ux', 'user experience', '사용자 경험', 'workflow', '워크플로우', 'automation', '자동화'
    ]
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