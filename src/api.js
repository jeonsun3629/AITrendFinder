const axios = require('axios');
require('dotenv').config();

// 환경변수에서 API 키 가져오기
const API_KEY = process.env.API_KEY;
const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY;

/**
 * AI 뉴스 및 트렌드 검색 API
 */
async function searchAINews(query, limit = 10) {
    try {
        // Firecrawl API를 사용하여 AI 뉴스 검색 (실제 구현 시 API 키 필요)
        const response = await axios.get('https://api.firecrawl.dev/search', {
            headers: {
                'Authorization': `Bearer ${FIRECRAWL_KEY}`,
                'Content-Type': 'application/json'
            },
            params: {
                query,
                limit,
                filter: 'ai news'
            }
        });

        return response.data;
    } catch (error) {
        console.error('검색 API 오류:', error);
        throw new Error('검색 중 오류가 발생했습니다.');
    }
}

/**
 * 인기 뉴스 가져오기
 */
async function getPopularNews(limit = 5) {
    try {
        // 인기 뉴스를 가져오는 API 호출 (실제 구현 시 변경 필요)
        const response = await axios.get('https://api.firecrawl.dev/popular', {
            headers: {
                'Authorization': `Bearer ${FIRECRAWL_KEY}`,
                'Content-Type': 'application/json'
            },
            params: { limit }
        });

        return response.data;
    } catch (error) {
        console.error('인기 뉴스 API 오류:', error);
        throw new Error('인기 뉴스를 가져오는 중 오류가 발생했습니다.');
    }
}

/**
 * 이메일 뉴스레터 구독 API
 */
async function subscribeToNewsletter(email, name = '') {
    try {
        // 뉴스레터 구독 API 호출 (실제 구현 시 변경 필요)
        const response = await axios.post('https://api.yourdomain.com/subscribe', {
            email,
            name
        });

        return response.data;
    } catch (error) {
        console.error('뉴스레터 구독 API 오류:', error);
        throw new Error('뉴스레터 구독 중 오류가 발생했습니다.');
    }
}

/**
 * 최신 AI 트렌드 가져오기
 */
async function getLatestTrends(limit = 10) {
    try {
        // 최신 AI 트렌드를 가져오는 API 호출 (실제 구현 시 변경 필요)
        const response = await axios.get('https://api.firecrawl.dev/trends', {
            headers: {
                'Authorization': `Bearer ${FIRECRAWL_KEY}`,
                'Content-Type': 'application/json'
            },
            params: { limit }
        });

        return response.data;
    } catch (error) {
        console.error('최신 트렌드 API 오류:', error);
        throw new Error('최신 트렌드를 가져오는 중 오류가 발생했습니다.');
    }
}

/**
 * AI 모델 정보 가져오기
 */
async function getAIModels() {
    try {
        // AI 모델 정보를 가져오는 API 호출 (실제 구현 시 변경 필요)
        const response = await axios.get('https://api.yourdomain.com/models');
        return response.data;
    } catch (error) {
        console.error('AI 모델 API 오류:', error);
        throw new Error('AI 모델 정보를 가져오는 중 오류가 발생했습니다.');
    }
}

module.exports = {
    searchAINews,
    getPopularNews,
    subscribeToNewsletter,
    getLatestTrends,
    getAIModels
}; 