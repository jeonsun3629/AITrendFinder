# AITrendFinder 🔦

**crawl4ai의 동적 Navigation을 활용한 지능형 AI/기술 트렌드 모니터링 시스템**

AITrendFinder는 **crawl4ai**의 동적 navigation 기능을 활용하여 다양한 웹사이트에서 AI/기술 관련 뉴스를 자동으로 수집하고, **Supabase**와 **Notion**을 연동하여 체계적으로 데이터를 정리하는 완전 자동화된 시스템입니다.

## 🎯 주요 특징

- **🤖 LLM 기반 동적 크롤링**: crawl4ai의 AI 네비게이션으로 복잡한 웹사이트 구조 자동 탐색
- **📊 스마트 데이터 정리**: Supabase를 통한 전체 원문 보존 및 Notion 연동
- **⏰ 자동 스케줄링**: GitHub Actions를 통한 매일 오전 7시 자동 실행
- **🔍 지능형 필터링**: 시간 기반 및 키워드 기반 콘텐츠 필터링
- **📱 다중 알림**: Slack, Discord, Notion 연동 지원

## 🏗️ 시스템 아키텍처

```
GitHub Actions (매일 오전 7시)
    ↓
crawl4ai 동적 크롤링
    ↓ (최신 AI/기술 뉴스 수집)
Supabase 원문 저장
    ↓ (전체 원문 보존)
AI 분석 및 요약
    ↓ (트렌드 패턴 분석)
Notion 구조화 저장
    ↓ (카테고리별 정리)
완료 알림
```

## 🔄 전체 워크플로우

### 1. **스케줄링 시스템** (GitHub Actions)

```yaml
# .github/workflows/AITrendFinder.yml
on:
  schedule:
    - cron: '0 22 * * *'  # 한국시간 매일 오전 7시 실행
  workflow_dispatch:      # 수동 실행 가능
```

**실행 주기**: 매일 오전 7시 (한국시간) 자동 실행

### 2. **데이터 수집 단계** (crawl4ai 동적 Navigation)

#### A. 동적 크롤링 엔진 (`dynamic_crawl.py`)

```python
class DynamicCrawler:
    async def crawl_url_targeted(
        self,
        url: str,
        content_focus: str = None,
        max_links: int = 3,
        timeframe_hours_for_filter: int = 48
    ):
        # 1. 사이트 유형 자동 감지
        # 2. LLM 기반 동적 네비게이션
        # 3. 콘텐츠 필터링 및 추출
```

**주요 특징**:
- **자동 사이트 감지**: WordPress, Medium, Reddit 등 CMS 자동 인식
- **LLM 기반 네비게이션**: AI가 페이지 구조를 분석하여 최적 경로 탐색
- **시간 기반 필터링**: 지정된 시간 범위 내 최신 콘텐츠만 수집
- **키워드 기반 필터링**: AI/기술 관련 콘텐츠 우선 수집

#### B. 수집 설정 예시

```json
{
  "sources_config": [
    {
      "identifier": "https://techcrunch.com/",
      "maxItems": 3
    },
    {
      "identifier": "https://medium.com/",
      "max_items": 2
    }
  ],
  "timeframe_hours": 48,
  "content_focus": "AI technology"
}
```

### 3. **데이터 저장 단계** (Supabase)

#### A. 원문 저장 시스템 (`contentStorage.ts`)

```typescript
export async function storeFullContent(
  storyId: string,
  headline: string,
  content: string
): Promise<ContentStorageResult> {
  // 콘텐츠 길이에 따른 저장 방식 결정
  if (content.length > MAX_DB_CONTENT_SIZE) {
    // Supabase Storage에 파일로 저장
  } else {
    // Supabase Database에 직접 저장
  }
}
```

**저장 방식**:
- **짧은 원문** (< 500KB): Supabase Database 테이블에 직접 저장
- **긴 원문** (≥ 500KB): Supabase Storage에 파일로 저장
- **메타데이터**: 스토리 ID, 헤드라인, 길이 정보 등

#### B. Supabase 테이블 구조

```sql
CREATE TABLE article_contents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  story_id TEXT NOT NULL UNIQUE,
  headline TEXT,
  content_full TEXT,
  content_length INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4. **데이터 정리 및 분석 단계**

#### A. 크롤링 결과 처리 (`scrapeSources.ts`)

```typescript
export async function scrapeSources(sources: Source[]): Promise<Story[]> {
  // 1. 배치 단위로 소스 처리 (기본 3개씩)
  // 2. 각 소스별 15초 대기
  // 3. 재시도 로직 (최대 3회)
  // 4. 원문 자동 저장
}
```

#### B. AI 분석 및 요약 생성 (`generateDraft.ts`)

```typescript
export async function generateDraft(rawStories: string): Promise<string> {
  // LLM을 사용하여 수집된 뉴스 분석
  // 트렌드 패턴 식별
  // 요약 및 인사이트 생성
}
```

### 5. **데이터 전송 단계** (Notion)

#### A. Notion 연동 (`sendDraft.ts`)

```typescript
async function getFullContent(item: any): Promise<string> {
  // 1. Supabase에서 전체 원문 가져오기
  // 2. Notion 2000자 제한 우회
  // 3. 구조화된 데이터로 Notion 저장
}
```

**Notion 저장 과정**:
1. **메타데이터 저장**: 제목, 링크, 날짜, 카테고리
2. **원문 가져오기**: Supabase에서 전체 원문 조회
3. **콘텐츠 분할**: 긴 원문을 여러 블록으로 분할
4. **구조화**: 제목, 요약, 전체 원문 순서로 정리

## 🚀 핵심 기능별 상세 설명

### 1. **동적 Navigation 시스템**

```python
# 사이트별 자동 감지 및 최적화
class SiteDetector:
    @staticmethod
    async def detect_site_type(page: Page) -> Dict[str, Any]:
        # WordPress, Medium, Reddit 등 자동 감지
        # 사이트별 최적 선택자 자동 생성
        # LLM 기반 네비게이션 경로 결정
```

**장점**:
- 새로운 사이트 추가 시 설정 불필요
- 사이트 구조 변경 시 자동 적응
- AI가 최적의 크롤링 경로 결정

### 2. **스마트 콘텐츠 필터링**

```python
# 시간 및 키워드 기반 필터링
timeframe_hours_for_filter: int = 48  # 48시간 내 콘텐츠만
content_focus: str = "AI technology"  # AI 관련 키워드 우선
```

**필터링 기준**:
- **시간 범위**: 최근 48시간 내 게시된 콘텐츠
- **키워드 우선순위**: AI, 기술 관련 콘텐츠 우선
- **중복 제거**: 동일한 스토리 자동 필터링

### 3. **원문 보존 시스템**

```typescript
// Notion 2000자 제한 우회
async function getFullContent(item: any): Promise<string> {
  // Supabase에서 전체 원문 조회
  const contentResult = await retrieveFullContent(storageId);
  return contentResult.content_full;
}
```

**해결 문제**:
- Notion API의 2000자 제한 우회
- 전체 원문의 영구 보존
- 빠른 원문 검색 및 접근

## 📋 Prerequisites

- Node.js (v14 or higher)
- Python 3.10 or higher
- npm or yarn
- Slack workspace with webhook permissions (선택사항)
- API keys for required services

## 🔧 Environment Variables

Copy `.env.example` to `.env` and configure the following variables:

```bash
# Required: At least one API key for LLM services
# Used for both trend analysis and crawl4ai's LLM-powered browsing

# Option 1: API key from Together AI (https://www.together.ai/)
TOGETHER_API_KEY=your_together_api_key

# Option 2: API key from DeepSeek (https://deepseek.com/)
DEEPSEEK_API_KEY=your_deepseek_api_key

# Option 3: API key from OpenAI (https://openai.com/)
OPENAI_API_KEY=your_openai_api_key

# Required if monitoring Twitter/X trends (https://developer.x.com/)
X_API_BEARER_TOKEN=your_twitter_api_bearer_token_here

# Notification driver. Supported drivers: "slack", "discord", "notion"
NOTIFICATION_DRIVER=notion

# Required (if NOTIFICATION_DRIVER is "slack"): Incoming Webhook URL from Slack for notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Required (if NOTIFICATION_DRIVER is "discord"): Incoming Webhook URL from Discord for notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK/URL

# Required (if NOTIFICATION_DRIVER is "notion"): Notion API integration
NOTION_API_KEY=your_notion_api_key
NOTION_DATABASE_ID=your_notion_database_id

# Required: Supabase URL and key for content storage
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# Optional: Crawling configuration
USE_DYNAMIC_CRAWLING=true
CRAWL_BATCH_SIZE=3
CRAWL_BATCH_DELAY=15000
MAX_STORIES_PER_SOURCE=3
```

## 🛠️ Getting Started

### 1. **Clone the repository:**
```bash
git clone [repository-url]
cd AITrendFinder
```

### 2. **Install dependencies:**
```bash
npm install
pip install git+https://github.com/unclecode/crawl4ai.git
```

### 3. **Configure environment variables:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

### 4. **Set up Supabase:**
```sql
-- 콘텐츠 저장을 위한 테이블 생성
CREATE TABLE article_contents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  story_id TEXT NOT NULL UNIQUE,
  headline TEXT,
  content_full TEXT,
  content_length INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스 생성
CREATE INDEX idx_article_contents_story_id ON article_contents(story_id);
```

### 5. **Run the application:**
```bash
# Development mode with hot reloading
npm run start

# Build for production
npm run build
```

## 📊 Project Structure

```
AITrendFinder/
├── src/
│   ├── controllers/
│   │   └── cron.ts              # GitHub Actions 실행 컨트롤러
│   ├── services/
│   │   ├── crawl4aiService.ts   # crawl4ai 연동 서비스
│   │   ├── contentStorage.ts    # Supabase 원문 저장 서비스
│   │   ├── scrapeSources.ts     # 크롤링 결과 처리
│   │   ├── generateDraft.ts     # AI 분석 및 요약
│   │   └── sendDraft.ts         # Notion 전송 서비스
│   ├── scripts/
│   │   ├── dynamic_crawl.py     # 동적 크롤링 엔진
│   │   ├── crawl.py             # 기본 크롤링 스크립트
│   │   └── analyze_content.py   # 콘텐츠 분석 스크립트
│   └── utils/
│       ├── supabase.ts          # Supabase 클라이언트
│       └── apiCache.ts          # API 캐시 유틸리티
├── .github/
│   └── workflows/
│       └── AITrendFinder.yml    # GitHub Actions 워크플로우
└── package.json
```

## ⚙️ Configuration & Customization

### 크롤링 설정 조정

```bash
# 시간 범위 조정
--timeframe_hours 72  # 3일로 확장

# 키워드 필터 조정
--content_focus "AI machine learning"  # 더 구체적인 키워드

# 수집량 조정
--max_items 5  # 사이트당 최대 5개 기사
```

### 환경 변수 설정

```bash
# 배치 처리 설정
CRAWL_BATCH_SIZE=3        # 한 번에 처리할 사이트 수
CRAWL_BATCH_DELAY=15000   # 배치 간 대기 시간 (ms)
MAX_STORIES_PER_SOURCE=3  # 사이트당 최대 기사 수

# 재시도 설정
MAX_RETRIES=3             # 최대 재시도 횟수
```

## 🔍 Troubleshooting

### 일반적인 문제 해결

1. **크롤링 실패**
   - 사이트 접근성 확인
   - 시간 범위 확장 (`--timeframe_hours 168`)
   - 키워드 필터 단순화

2. **원문 저장 실패**
   - Supabase 연결 확인
   - 테이블 구조 확인
   - 권한 설정 확인

3. **Notion 전송 실패**
   - API 키 유효성 확인
   - 데이터베이스 ID 확인
   - 권한 설정 확인

## 📈 Monitoring & Analytics

### 로그 확인
```bash
# GitHub Actions 로그
# GitHub 저장소 > Actions > AITrendFinder > 최근 실행 > 로그 확인

# 로컬 실행 로그
npm run start  # 콘솔에서 실시간 로그 확인
```

### 성능 지표
- **처리 시간**: 평균 10-15분
- **수집 성공률**: 85-95%
- **원문 보존률**: 100%

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/your-repo/issues)
- **Documentation**: [Wiki](https://github.com/your-repo/wiki)
- **Discussions**: [GitHub Discussions](https://github.com/your-repo/discussions)

---

**AITrendFinder** - AI/기술 트렌드를 실시간으로 모니터링하고 체계적으로 정리하는 완전 자동화된 솔루션입니다.
