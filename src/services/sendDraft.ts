import axios from 'axios';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';

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

async function sendDraftToNotion(draft_post: string) {
  try {
    // 스토리를 파싱하여 각 항목을 분리
    const titleMatch = draft_post.match(/🚀 AI and LLM Trends on X for (.*?)\n\n/);
    const title = titleMatch ? titleMatch[1] : new Date().toLocaleDateString();
    
    // 글머리 기호로 분리된 항목들 추출
    const items = draft_post
      .split('\n\n')
      .slice(1) // 제목 이후의 항목들만 사용
      .map(item => {
        const lines = item.split('\n');
        const description = lines[0].replace('• ', '');
        const link = lines[1] ? lines[1].trim() : '';
        return { description, link };
      });

    // 각 트렌드 항목마다 별도의 Notion 페이지 생성
    for (const item of items) {
      if (!item.description) continue;
      
      await notion.pages.create({
        parent: {
          database_id: process.env.NOTION_DATABASE_ID || '',
        },
        properties: {
          Title: {
            title: [
              {
                text: {
                  content: item.description,
                },
              },
            ],
          },
          Date: {
            date: {
              start: new Date().toISOString().split('T')[0],
            },
          },
          Content: {
            rich_text: [
              {
                text: {
                  content: item.description,
                }
              }
            ]
          },
          URL: {
            url: item.link || null,
          }
        },
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: { 
                    content: item.description,
                  },
                }
              ],
            }
          },
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: { 
                    content: item.link || '',
                    link: item.link ? { url: item.link } : null
                  },
                }
              ],
            }
          }
        ],
      });
    }

    return `Success sending ${items.length} trends to Notion at ${new Date().toISOString()}`;
  } catch (error) {
    console.log('Error sending draft to Notion');
    console.error(error);
    throw error;
  }
}

export async function sendDraft(draft_post: string) {
  const notificationDriver = process.env.NOTIFICATION_DRIVER?.toLowerCase();

  switch (notificationDriver) {
    case 'slack':
      return sendDraftToSlack(draft_post);
    case 'discord':
      return sendDraftToDiscord(draft_post);
    case 'notion':
      return sendDraftToNotion(draft_post);
    default:
      throw new Error(`Unsupported notification driver: ${notificationDriver}`);
  }
}