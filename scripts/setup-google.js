import "dotenv/config";
import { GoogleStore } from "../lib/google-store.js";
try {
  await new GoogleStore().assertPrivateFolder();
  console.log("비공개 공유 드라이브 폴더 확인 완료");
} catch {
  console.error("Google Drive 준비 실패: 환경변수, 공유 드라이브 권한, Drive API 활성화를 확인하세요.");
  process.exitCode = 1;
}
