# Trend Finder 🔦

**Stay on top of trending topics on social media — all in one place.**

Trend Finder collects and analyzes posts from key influencers, then sends a Slack or Discord notification when it detects new trends or product launches. This has been a complete game-changer for the Firecrawl marketing team by:

- **Saving time** normally spent manually searching social channels
- **Keeping you informed** of relevant, real-time conversations
- **Enabling rapid response** to new opportunities or emerging industry shifts

_Spend less time hunting for trends and more time creating impactful campaigns._

## Watch the Demo & Tutorial video

[![Thumbnail](https://i.ytimg.com/vi/puimQSun92g/hqdefault.jpg)](https://www.youtube.com/watch?v=puimQSun92g)

Learn how to set up Trend Finder and start monitoring trends in this video!

## How it Works

1. **Data Collection** 📥
   - Monitors selected influencers' posts on Twitter/X using the X API (Warning: the X API free plan is rate limited to only monitor 1 X account every 15 min)
   - Monitors websites for new releases and news with Firecrawl's /extract
   - Runs on a scheduled basis using cron jobs

2. **AI Analysis** 🧠
   - Processes collected content through Together AI
   - Identifies emerging trends, releases, and news.
   - Analyzes sentiment and relevance

3. **Notification System** 📢
   - When significant trends are detected, sends Slack or Discord notifications based on cron job setup
   - Provides context about the trend and its sources
   - Enables quick response to emerging opportunities

## Features

- 🤖 AI-powered trend analysis using Together AI
- 📱 Social media monitoring (Twitter/X integration)
- 🔍 Website monitoring with Firecrawl
- 💬 Instant Slack or Discord notifications
- ⏱️ Scheduled monitoring using cron jobs

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Slack workspace with webhook permissions
- API keys for required services

## Environment Variables

Copy `.env.example` to `.env` and configure the following variables:

```
# Optional: API key from Together AI for trend analysis (https://www.together.ai/)
TOGETHER_API_KEY=your_together_api_key

# Optional: API key from DeepSeek for trend analysis (https://deepseek.com/)
DEEPSEEK_API_KEY=

# Optional: API key from OpenAI for trend analysis (https://openai.com/)
OPENAI_API_KEY=

# Required if monitoring web pages (https://www.firecrawl.dev/)
FIRECRAWL_API_KEY=your_firecrawl_api_key

# Required if monitoring Twitter/X trends (https://developer.x.com/)
X_API_BEARER_TOKEN=your_twitter_api_bearer_token_here

# Notification driver. Supported drivers: "slack", "discord"
NOTIFICATION_DRIVER=discord

# Required (if NOTIFICATION_DRIVER is "slack"): Incoming Webhook URL from Slack for notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Required (if NOTIFICATION_DRIVER is "discord"): Incoming Webhook URL from Discord for notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK/URL

# Optional: Supabase URL
SUPABASE_URL=

# Optional: Supabase Anon Key
SUPABASE_ANON_KEY=
```

## Getting Started

1. **Clone the repository:**
   ```bash
   git clone [repository-url]
   cd trend-finder
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Run the application:**
   ```bash
   # Development mode with hot reloading
   npm run start

   # Build for production
   npm run build
   ```

## Project Structure

```
trend-finder/
├── src/
│   ├── controllers/    # Request handlers
│   ├── services/       # Business logic
│   └── index.ts        # Application entry point
├── .env.example        # Environment variables template
├── package.json        # Dependencies and scripts
└── tsconfig.json       # TypeScript configuration
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 전체 원문 저장 기능

AITrendFinder는 크롤링한 전체 원문을 Supabase에 저장하는 기능을 지원합니다. 이 기능을 사용하면 Notion API의 2000자 제한을 우회하여 원문 전체를 보존할 수 있습니다.

### 설정 방법

1. [Supabase](https://supabase.com)에 가입하고 새 프로젝트를 생성합니다.
2. SQL 에디터에서 다음 쿼리를 실행하여 필요한 테이블과 저장소를 생성합니다:

```sql
-- 콘텐츠 저장을 위한 테이블 생성
CREATE TABLE article_contents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  story_id TEXT NOT NULL UNIQUE,
  headline TEXT,
  content_full TEXT,
  storage_path TEXT,
  content_length INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스 생성
CREATE INDEX idx_article_contents_story_id ON article_contents(story_id);

-- 저장소 버킷 생성
INSERT INTO storage.buckets (id, name, public) 
VALUES ('article-contents', 'article-contents', false);
```

3. `.env` 파일에 Supabase 관련 환경 변수를 추가합니다:

```
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 작동 방식

1. 크롤링 단계에서 각 기사의 전체 원문을 추출합니다.
2. 원문 길이에 따라 자동으로 저장 방식이 결정됩니다:
   - 짧은 원문 (100KB 미만): Supabase 데이터베이스에 직접 저장
   - 긴 원문 (100KB 이상): Supabase Storage에 파일로 저장
3. Notion에 저장 시, 전체 원문이 있는 경우 자동으로 가져와 Content_full 필드에 저장합니다.

### 장점

- Notion API의 2000자 텍스트 제한 우회
- 대용량 원문도 효율적으로 저장
- 캐싱을 통한 성능 최적화
