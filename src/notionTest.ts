import { Client } from '@notionhq/client';
import dotenv from 'dotenv';

dotenv.config();

// Notion 클라이언트 설정
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

async function testNotion() {
  try {
    console.log('Notion API 키:', process.env.NOTION_API_KEY?.substring(0, 4) + '...');
    console.log('Notion 데이터베이스 ID:', process.env.NOTION_DATABASE_ID?.substring(0, 4) + '...');
    
    // 테스트 데이터
    const testData = {
      original: '이것은 테스트 영문입니다.',
      translated: '이것은 테스트 한글입니다.',
      title_ko: '테스트 제목',
      link: 'https://example.com'
    };
    
    // Notion에 페이지 생성
    const response = await notion.pages.create({
      parent: {
        database_id: process.env.NOTION_DATABASE_ID || '',
      },
      properties: {
        Title: {
          title: [
            {
              text: {
                content: testData.title_ko || testData.translated || testData.original,
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
                content: testData.translated || '',
              }
            }
          ]
        },
        Content_og: {
          rich_text: [
            {
              text: {
                content: testData.original || '',
              }
            }
          ]
        },
        URL: {
          url: testData.link || null,
        }
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { 
                  content: testData.translated || testData.original,
                },
              }
            ],
          }
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { 
                  content: '원문: ' + testData.original,
                },
              }
            ],
          }
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { 
                  content: testData.link || '',
                  link: testData.link ? { url: testData.link } : null
                },
              }
            ],
          }
        }
      ],
    });
    
    console.log('테스트 성공!', response);
    return '테스트가 성공적으로 완료되었습니다.';
  } catch (error) {
    console.error('Notion API 테스트 오류:', error);
    return `오류 발생: ${error}`;
  }
}

// 테스트 실행
testNotion().then(console.log); 