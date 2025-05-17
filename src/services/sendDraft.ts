import axios from 'axios';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { retrieveFullContent } from './contentStorage';
import { OpenAI } from 'openai';

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
 * 배열에서 최대 3개의 유효한 URL을 찾아 반환
 */
function getMultipleValidUrls(urls: any[] | undefined, maxUrls: number = 3): string[] {
  if (!urls || !Array.isArray(urls)) {
    return [];
  }
  
  const validUrls: string[] = [];
  
  for (const url of urls) {
    const urlStr = typeof url === 'string' ? url : '';
    if (isValidUrl(urlStr) && !validUrls.includes(urlStr)) {
      validUrls.push(urlStr);
      if (validUrls.length >= maxUrls) {
        break;
      }
    }
  }
  
  return validUrls;
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
        const contentResult = await retrieveFullContent(storageId);
        if (contentResult && contentResult.content_full) {
          console.log(`Supabase에서 전체 원문을 가져왔습니다 (${contentResult.content_full.length} 바이트)`);
          return contentResult.content_full;
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
  const maxLength = 2000;
  
  // 불릿 포인트가 있는 경우 각 항목을 분리하여 별도의 텍스트 항목으로 처리
  if (textContent.includes('• ')) {
    // 줄바꿈된 불릿 포인트를 개별 항목으로 분리
    const bulletPoints = textContent.split('\n\n');
    
    if (bulletPoints.length > 1) {
      console.log(`불릿 포인트 ${bulletPoints.length}개를 각각의 텍스트 블록으로 변환합니다.`);
      
      // 각 불릿 포인트를 별도의 rich_text 항목으로 변환 (각 항목은 2000자 제한 준수)
      return bulletPoints.map(point => {
        const trimmedPoint = point.trim();
        if (trimmedPoint.length <= maxLength) {
          return { text: { content: trimmedPoint + '\n' } };
        } else {
          // 2000자 초과 시, 잘라서 반환
          return { text: { content: trimmedPoint.substring(0, maxLength) + '\n' } };
        }
      });
    }
  }
  
  // 텍스트가 2000자 제한을 초과하는 경우 여러 청크로 나눔
  if (textContent.length > maxLength) {
    console.log(`텍스트가 노션 제한(${maxLength}자)을 초과합니다. 길이: ${textContent.length}자. 여러 청크로 분할합니다.`);
    
    const chunks: { text: { content: string } }[] = [];
    // 2000자씩 잘라서 여러 개의 리치 텍스트 항목으로 분할
    for (let i = 0; i < textContent.length; i += maxLength) {
      chunks.push({
        text: { content: textContent.substring(i, Math.min(i + maxLength, textContent.length)) }
      });
    }
    
    console.log(`총 ${chunks.length}개의 텍스트 청크로 분할됨`);
    return chunks;
  }
  
  // 일반 텍스트이면서 제한 내인 경우 단일 항목으로 반환
  return [{ text: { content: textContent } }];
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
    
    // Notion 클라이언트 초기화
    const notion = new Client({
      auth: process.env.NOTION_API_KEY,
    });
    
    const now = new Date();
    now.setHours(now.getHours() + 9); // KST 시간으로 조정 (UTC+9)
    const koreaDateStr = now.toISOString().split('T')[0];
    console.log(`현재 한국 날짜로 설정: ${koreaDateStr}`);
    
    // 데이터베이스 확인
    try {
      const databaseId = process.env.NOTION_DATABASE_ID || '';
      console.log(`Notion 데이터베이스 확인 시도 (ID: ${databaseId.substring(0, 32)})`);
      
      const database = await notion.databases.retrieve({
        database_id: databaseId
      });
      
      // 데이터베이스 필드 확인
      console.log(`Notion 데이터베이스 필드 목록:`);
      const properties = database.properties;
      for (const key in properties) {
        console.log(`- ${key} (${properties[key].type})`);
      }
    } catch (dbError) {
      console.error('Notion 데이터베이스 확인 오류:', dbError);
    }
    
    console.log(`Notion에 총 ${draft.translatedContent.length}개의 페이지를 생성합니다.`);
    
    // API 속도 제한을 고려한 Notion 페이지 생성 지연 함수
    const createNotionPageWithDelay = async (item: any, index: number): Promise<void> => {
      // 이전 요청과의 간격을 위한 지연 (첫 번째 요청 제외)
      if (index > 0) {
        // 1-3초 랜덤 지연
        const delay = 1000 + Math.random() * 2000;
        console.log(`Notion API 요청 간 ${Math.round(delay)}ms 대기 중...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // 제목 정보 추출 및 유효성 검증
      let title = '무제';
      if (typeof item.title_ko === 'string' && item.title_ko.trim()) {
        title = item.title_ko.trim();
      } else if (typeof item.title_ko === 'object' && item.title_ko?.text) {
        title = String(item.title_ko.text).trim();
      } else if (typeof item.translated === 'string' && item.translated.trim()) {
        title = item.translated.trim().split('\n')[0].substring(0, 100);
      } else if (typeof item.original === 'string' && item.original.trim()) {
        title = item.original.trim().split('\n')[0].substring(0, 100);
      }
      
      console.log(`Notion에 페이지 생성 중: ${title}`);
      
      // 요약 내용 로깅
      if (item.summary_ko) {
        console.log(`Summary_ko 내용 길이: ${item.summary_ko.length}바이트`);
      }
      
      if (item.content_full_kr) {
        console.log(`content_full_kr 내용 길이: ${item.content_full_kr.length}바이트`);
      }
      
      // 원문 콘텐츠 확인
      let fullContent = '';
      console.log(`원문 내용 길이: ${fullContent.length}바이트`);
      
      // Supabase에서 원문 가져오기
      if (item.supabase_id) {
        try {
          console.log(`Supabase에서 원문 가져오기 시도: ${title} (ID: ${item.supabase_id})`);
          const contentResult = await retrieveFullContent(item.supabase_id);
          if (contentResult && contentResult.content_full) {
            fullContent = contentResult.content_full;
            console.log(`Supabase에서 전체 원문을 가져왔습니다 (${fullContent.length} 바이트)`);
          }
        } catch (error) {
          console.error(`Supabase에서 콘텐츠 가져오기 오류 (${item.supabase_id}):`, error);
        }
      } else if (item.content_storage_id) {
        try {
          console.log(`Supabase에서 원문 가져오기 시도: ${title} (ID: ${item.content_storage_id})`);
          const contentResult = await retrieveFullContent(item.content_storage_id);
          if (contentResult && contentResult.content_full) {
            fullContent = contentResult.content_full;
            console.log(`Supabase에서 전체 원문을 가져왔습니다 (${fullContent.length} 바이트)`);
          }
        } catch (error) {
          console.error(`Supabase에서 콘텐츠 가져오기 오류 (${item.content_storage_id}):`, error);
        }
      }
      
      // 원문이 2000자를 초과하는 경우 처리
      if (fullContent.length > 2000) {
        console.log(`원문 전체 내용 길이: ${fullContent.length}바이트 (2000자 초과, 분할 필요)`);
        // 선택적으로 2000자로 자름 - 콘텐츠 요약 방식에 따라 조정
        fullContent = fullContent.substring(0, 2000);
      }
      
      // 블록 생성
      const blocks: BlockObjectRequest[] = [];
      
      // 불릿 포인트 형식의 content_full_kr를 개별 블록으로 추가
      // 10개 불릿 포인트 생성 (콘텐츠에서 자동 생성)
      // Supabase에서 가져온 원문 내용으로부터 불릿 포인트 형식 생성
      if (!item.content_full_kr && fullContent) {
        try {
          console.log("원문에서 10개의 핵심 요약 불릿 포인트 생성 중...");
          item.content_full_kr = await generateBulletPointsFromContent(fullContent, 10);
        } catch (bulletError) {
          console.error("불릿 포인트 생성 오류:", bulletError);
          item.content_full_kr = '';
        }
      }
      
      if (item.content_full_kr && item.content_full_kr.includes('• ')) {
        // 구분선 추가
        blocks.push({
          object: "block",
          type: "divider",
          divider: {}
        });
        
        blocks.push({
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "주요 내용 요약" } }]
          }
        });
        
        // 문단 추가 (공백 생성)
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: []
          }
        });
        
        // 불릿 포인트 항목 분리
        const bulletPoints = item.content_full_kr.split('\n\n')
          .filter((line: string) => line.trim() !== '')
          .map((line: string) => line.trim());
        
        console.log(`불릿 포인트 항목 ${bulletPoints.length}개를 블록으로 변환합니다:`);
        bulletPoints.forEach((point: string, index: number) => {
          if (index < 10) { // 최대 10개 불릿 포인트만 표시
            console.log(`  ${index + 1}. ${point.substring(0, 50)}...`);
          }
        });
        
        // 각 불릿 포인트를 개별 블록으로 추가 (최대 10개)
        const limitedBulletPoints = bulletPoints.slice(0, 10);
        limitedBulletPoints.forEach((point: string) => {
          const content = point.startsWith('• ') ? point.substring(2).trim() : point;
          
          // 불릿 포인트가 2000자를 초과하는 경우 처리
          if (content.length > 2000) {
            // 첫 번째 블록은 불릿 리스트 아이템으로 (2000자로 제한)
            blocks.push({
              object: "block",
              type: "bulleted_list_item",
              bulleted_list_item: {
                rich_text: [{ 
                  type: "text", 
                  text: { content: content.substring(0, 2000) }
                }]
              }
            });
          } else {
            // 2000자 이하인 경우 단일 블록
            blocks.push({
              object: "block",
              type: "bulleted_list_item",
              bulleted_list_item: {
                rich_text: [{ 
                  type: "text", 
                  text: { content }
                }]
              }
            });
          }
        });
        
        // 구분선 추가
        blocks.push({
          object: "block",
          type: "divider",
          divider: {}
        });
      }
      
      // 이미지 URL 추가 (최대 3개)
      const imageUrls = getMultipleValidUrls(item.image_url);
      if (imageUrls.length > 0) {
        // 구분선 및 이미지 헤더 추가
        blocks.push({
          object: "block",
          type: "divider",
          divider: {}
        });
        
        blocks.push({
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ type: "text", text: { content: "관련 이미지" } }]
          }
        });
        
        // 각 이미지 URL을 개별 블록으로 추가 (최대 3개)
        imageUrls.slice(0, 3).forEach((imgUrl, index) => {
          blocks.push({
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                { 
                  type: "text", 
                  text: { 
                    content: `이미지 ${index + 1}: `,
                  }
                },
                { 
                  type: "text", 
                  text: { 
                    content: imgUrl,
                    link: { url: imgUrl }
                  }
                }
              ]
            }
          });
        });
      }
      
      // 비디오 URL 추가 (최대 3개)
      const videoUrls = getMultipleValidUrls(item.video_url);
      if (videoUrls.length > 0) {
        // 이미지가 없었다면 구분선 추가
        if (imageUrls.length === 0) {
          blocks.push({
            object: "block",
            type: "divider",
            divider: {}
          });
        }
        
        blocks.push({
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ type: "text", text: { content: "관련 비디오" } }]
          }
        });
        
        // 각 비디오 URL을 개별 블록으로 추가 (최대 3개)
        videoUrls.slice(0, 3).forEach((videoUrl, index) => {
          blocks.push({
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                { 
                  type: "text", 
                  text: { 
                    content: `비디오 ${index + 1}: `,
                  }
                },
                { 
                  type: "text", 
                  text: { 
                    content: videoUrl,
                    link: { url: videoUrl }
                  }
                }
              ]
            }
          });
        });
      }
      
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
                    content: title,
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
              rich_text: createRichText(fullContent.substring(0, 2000))
            },
            Content_full_kr: {
              rich_text: createRichText(item.content_full_kr ? item.content_full_kr.substring(0, 2000) : '')
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
        
        console.log(`페이지 생성 성공: ${title}`);
      } catch (notionError) {
        console.error(`Notion 페이지 생성 오류 (${title}):`, notionError);
        throw notionError;
      }
    };
    
    // 순차적으로 페이지 생성 (병렬 처리 대신)
    for (let i = 0; i < draft.translatedContent.length; i++) {
      const item = draft.translatedContent[i];
      if (!item.translated && !item.original) continue;
      
      try {
        await createNotionPageWithDelay(item, i);
      } catch (pageError) {
        console.error(`페이지 #${i+1} 생성 실패:`, pageError);
        // 오류가 발생해도 다음 페이지 생성 시도
        continue;
      }
    }
    
    return `Success sending ${draft.translatedContent.length} trends to Notion at ${new Date().toISOString()}`;
  } catch (error) {
    console.error('노션 데이터베이스 업데이트 오류:', error);
    throw error;
  }
}

/**
 * 원문에서 불릿 포인트 요약 생성
 * 
 * @param content 원본 콘텐츠 텍스트
 * @param numPoints 생성할 불릿 포인트 개수
 * @returns 불릿 포인트 형식의 요약
 */
async function generateBulletPointsFromContent(content: string, numPoints: number = 10): Promise<string> {
  try {
    // 콘텐츠가 너무 길면 중요 부분만 추출 (시작 부분과 끝 부분)
    let processedContent = content;
    if (content.length > 10000) {
      const firstPart = content.substring(0, 4000);
      const lastPart = content.substring(content.length - 4000);
      processedContent = `${firstPart}\n...\n${lastPart}`;
    }
    
    // OpenAI 클라이언트 초기화
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY as string,
    });
    
    // 재시도 로직과 함께 API 호출
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        // 지연 시간 설정
        if (retryCount > 0) {
          const delayMs = Math.pow(2, retryCount) * 1000;
          console.log(`API 재시도 전 ${delayMs}ms 대기 중...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        
        const response = await client.chat.completions.create({
          model: "gpt-3.5-turbo", // GPT-4 대신 더 경제적인 모델 사용
          messages: [
            {
              role: "system",
              content: "당신은 텍스트를 짧고 명확한 불릿 포인트로 요약하는 전문가입니다."
            },
            {
              role: "user",
              content: `다음 텍스트의 핵심 내용을 ${numPoints}개의 명확하고 간결한 불릿 포인트로 요약해주세요. 각 불릿 포인트는 '• '로 시작하고 최대 2-3문장으로 제한해주세요.\n\n${processedContent}`
            }
          ],
          temperature: 0.3,
          max_tokens: 1500 // 응답 길이 제한
        });
        
        const bulletPoints = response.choices[0]?.message.content?.trim() || '';
        console.log(`${numPoints}개의 불릿 포인트 생성 완료`);
        return bulletPoints;
        
      } catch (error: any) {
        retryCount++;
        if (error.response?.status === 429) {
          console.warn(`API 속도 제한 초과 (재시도 ${retryCount}/${maxRetries})`);
        } else {
          console.error(`불릿 포인트 생성 오류 (재시도 ${retryCount}/${maxRetries}):`, error);
        }
        
        // 마지막 시도였는데 실패한 경우
        if (retryCount >= maxRetries) {
          throw error;
        }
      }
    }
    
    // 이 코드에 도달하지 않지만, TypeScript 컴파일러를 위한 반환값
    return '';
  } catch (error) {
    console.error('불릿 포인트 생성 중 오류:', error);
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