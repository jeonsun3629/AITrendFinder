import axios from 'axios';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';

dotenv.config();

// Notion 클라이언트 설정
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

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
      
      const blocks: BlockObjectRequest[] = [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { 
                  content: item.translated || item.original,
                },
              }
            ],
          }
        }
      ];
      
      // 원문이 있고 번역도 있는 경우 원문도 추가
      if (item.original && item.translated) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { 
                  content: '원문: ' + item.original,
                },
              }
            ],
          }
        });
      }
      
      // 링크 추가
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { 
                content: item.link || '',
                link: item.link ? { url: item.link } : null
              },
            }
          ],
        }
      });
      
      await notion.pages.create({
        parent: {
          database_id: process.env.NOTION_DATABASE_ID || '',
        },
        properties: {
          Title: {
            title: [
              {
                text: {
                  content: item.title_ko || item.translated || item.original,
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
            rich_text: [
              {
                text: {
                  content: item.translated || '',
                }
              }
            ]
          },
          Content_og: {
            rich_text: [
              {
                text: {
                  content: item.original || '',
                }
              }
            ]
          },
          URL: {
            url: item.link || null,
          },
          Category: {
            select: {
              name: getCategoryFromContent(item.category, item.translated || item.original)
            }
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