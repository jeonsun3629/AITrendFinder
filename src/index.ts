import { handleCron } from "./controllers/cron"
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  try {
    console.log(`Starting process to generate draft at ${new Date().toISOString()}`);
    await handleCron();
    
    // 모든 작업이 완료된 후 정리 작업
    console.log(`All tasks completed, cleaning up...`);
    
    // 남은 HTTP 연결이나 타이머가 닫히도록 시간 연장 (3초→10초)
    console.log(`Waiting for all connections to close before exit...`);
    setTimeout(() => {
      console.log(`Process exit initiated at ${new Date().toISOString()}`);
      process.exit(0);
    }, 10000); // 10초 후 종료 (충분한 시간 확보)
  } catch (error) {
    console.error(`Critical error in main process:`, error);
    // 오류 발생 시 비정상 종료 (시간 연장)
    console.log(`Exiting with error after cleanup delay...`);
    setTimeout(() => {
      console.log(`Process error exit at ${new Date().toISOString()}`);
      process.exit(1);
    }, 5000); // 5초 후 종료
  }
}

// 프로세스 종료 시그널 처리
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  setTimeout(() => {
    console.log('Graceful shutdown timed out, forcing exit');
    process.exit(0);
  }, 5000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  setTimeout(() => {
    console.log('Graceful shutdown timed out, forcing exit');
    process.exit(0);
  }, 5000);
});

main();

// If you want to run the cron job manually, uncomment the following line:
//cron.schedule(`0 17 * * *`, async () => {
//  console.log(`Starting process to generate draft...`);
//  await handleCron();
//});