const { Client } = require('@notionhq/client');
require('dotenv').config();

const notion = new Client({
  auth: process.env.NOTION_API_KEY
});

const databaseId = process.env.NOTION_DATABASE_ID;

/**
 * Notion 데이터베이스에서 블로그 포스트 가져오기
 */
async function getBlogPosts(limit = 10) {
  try {
    const response = await notion.databases.query({
      database_id: databaseId,
      sorts: [
        { property: 'date', direction: 'descending' }
      ],
      page_size: limit
    });
    
    return response.results.map(page => {
      // Notion에서 각 속성 추출
      return {
        id: page.id,
        title: page.properties.title?.title[0]?.plain_text || '제목 없음',
        content_kr: page.properties.content_kr?.rich_text[0]?.plain_text || '',
        content_og: page.properties.content_og?.rich_text[0]?.plain_text || '',
        date: page.properties.date?.date?.start || new Date().toISOString().split('T')[0],
        url: page.properties.url?.url || ''
      };
    });
  } catch (error) {
    console.error('Notion API 오류:', error);
    throw new Error('블로그 글을 가져오는 중 오류가 발생했습니다.');
  }
}

/**
 * Notion에 새 블로그 포스트 작성하기
 */
async function createBlogPost(data) {
  const { title, content_kr, content_og, url } = data;
  const date = data.date || new Date().toISOString().split('T')[0];
  
  try {
    const response = await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: title } }]
        },
        content_kr: {
          rich_text: [{ type: 'text', text: { content: content_kr } }]
        },
        content_og: {
          rich_text: [{ type: 'text', text: { content: content_og } }]
        },
        date: {
          date: { start: date }
        },
        url: {
          url: url
        }
      }
    });
    
    return response;
  } catch (error) {
    console.error('Notion API 오류:', error);
    throw new Error('블로그 글을 생성하는 중 오류가 발생했습니다.');
  }
}

module.exports = { getBlogPosts, createBlogPost }; 