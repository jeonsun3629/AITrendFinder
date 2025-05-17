# Trend Finder 🔦

**Stay on top of trending topics on social media — all in one place.**

Trend Finder collects and analyzes posts from key influencers, then sends a Slack or Discord notification when it detects new trends or product launches. This has been enhanced with open-source crawl4ai technology to provide intelligent web crawling with LLM capabilities.

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
   - Monitors websites for new releases and news with crawl4ai's intelligent LLM-powered crawling
   - Runs on a scheduled basis using cron jobs and GitHub Actions

2. **AI Analysis** 🧠
   - Processes collected content through Together AI, DeepSeek, or OpenAI
   - Identifies emerging trends, releases, and news
   - Analyzes sentiment and relevance

3. **Notification System** 📢
   - When significant trends are detected, sends Slack or Discord notifications based on cron job setup
   - Provides context about the trend and its sources
   - Enables quick response to emerging opportunities

## Features

- 🤖 AI-powered trend analysis using Together AI, DeepSeek, or OpenAI
- 📱 Social media monitoring (Twitter/X integration)
- 🔍 Website monitoring with crawl4ai (open-source LLM-friendly crawler)
- 💬 Instant Slack or Discord notifications
- ⏱️ Scheduled monitoring using GitHub Actions

## Prerequisites

- Node.js (v14 or higher)
- Python 3.10 or higher
- npm or yarn
- Slack workspace with webhook permissions
- API keys for required services

## Environment Variables

Copy `.env.example` to `.env` and configure the following variables:

```
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
NOTIFICATION_DRIVER=discord

# Required (if NOTIFICATION_DRIVER is "slack"): Incoming Webhook URL from Slack for notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Required (if NOTIFICATION_DRIVER is "discord"): Incoming Webhook URL from Discord for notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK/URL

# Optional: Notion API integration
NOTION_API_KEY=your_notion_api_key
NOTION_DATABASE_ID=your_notion_database_id

# Optional: Supabase URL and key for content storage
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
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
   pip install git+https://github.com/unclecode/crawl4ai.git
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

## Using GitHub Actions

This project is configured to run automatically using GitHub Actions. The workflow:

1. Sets up both Node.js and Python environments
2. Installs crawl4ai directly from GitHub
3. Runs the trend analysis on a schedule
4. Handles notifications based on your configuration

You can also manually trigger the workflow through the GitHub Actions tab.

## Project Structure

```
trend-finder/
├── src/
│   ├── controllers/    # Request handlers
│   ├── services/       # Business logic
│   ├── scripts/        # Python scripts for crawl4ai
│   └── index.ts        # Application entry point
├── .github/
│   └── workflows/      # GitHub Actions definitions
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

## crawl4ai 통합

이 프로젝트는 [crawl4ai](https://github.com/unclecode/crawl4ai)를 사용하여 웹사이트 크롤링을 수행합니다. crawl4ai는 오픈소스 LLM 기반 웹 크롤러로, 다음과 같은 기능을 제공합니다:

- LLM 기반 자동 네비게이션으로 복잡한 웹사이트 구조 탐색
- 마크다운으로 변환된 깔끔한 콘텐츠 추출
- 메타데이터 추출 (날짜, 이미지 URL 등)
- 다양한 LLM 프로바이더 지원 (OpenAI, Together AI, DeepSeek 등)

crawl4ai는 GitHub Actions 환경에서 자동으로 설치되고 실행됩니다. 로컬 개발 환경에서는 아래 명령어로 설치할 수 있습니다:

```bash
pip install git+https://github.com/unclecode/crawl4ai.git
```
