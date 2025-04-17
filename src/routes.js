const express = require('express');
const router = express.Router();
const api = require('./api');

// 검색 API 라우트
router.get('/api/search', async (req, res) => {
    try {
        const { query, limit } = req.query;
        
        if (!query) {
            return res.status(400).json({ error: '검색어를 입력해주세요.' });
        }
        
        const results = await api.searchAINews(query, limit || 10);
        res.json(results);
    } catch (error) {
        console.error('검색 라우트 오류:', error);
        res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
    }
});

// 인기 뉴스 API 라우트
router.get('/api/popular', async (req, res) => {
    try {
        const { limit } = req.query;
        const results = await api.getPopularNews(limit || 5);
        res.json(results);
    } catch (error) {
        console.error('인기 뉴스 라우트 오류:', error);
        res.status(500).json({ error: '인기 뉴스를 가져오는 중 오류가 발생했습니다.' });
    }
});

// 뉴스레터 구독 API 라우트
router.post('/api/subscribe', async (req, res) => {
    try {
        const { email, name } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: '이메일 주소를 입력해주세요.' });
        }
        
        const result = await api.subscribeToNewsletter(email, name || '');
        res.json({ success: true, message: '구독해 주셔서 감사합니다!' });
    } catch (error) {
        console.error('구독 라우트 오류:', error);
        res.status(500).json({ error: '구독 중 오류가 발생했습니다.' });
    }
});

// 최신 트렌드 API 라우트
router.get('/api/trends', async (req, res) => {
    try {
        const { limit } = req.query;
        const results = await api.getLatestTrends(limit || 10);
        res.json(results);
    } catch (error) {
        console.error('트렌드 라우트 오류:', error);
        res.status(500).json({ error: '최신 트렌드를 가져오는 중 오류가 발생했습니다.' });
    }
});

// AI 모델 정보 API 라우트
router.get('/api/models', async (req, res) => {
    try {
        const results = await api.getAIModels();
        res.json(results);
    } catch (error) {
        console.error('AI 모델 라우트 오류:', error);
        res.status(500).json({ error: 'AI 모델 정보를 가져오는 중 오류가 발생했습니다.' });
    }
});

module.exports = router; 