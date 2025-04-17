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
              name: item.category || "연구 동향"
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