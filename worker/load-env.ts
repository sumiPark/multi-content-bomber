// 워커는 Next.js와 별개의 Node 프로세스라 .env.local을 자동 로드하지 않는다.
// dev에서는 이 파일을 가장 먼저 import해 .env.local을 명시적으로 로드한다.
// prod(Railway)에서는 .env.local이 없고 환경변수가 플랫폼 레벨에서 주입되므로 dotenv는 no-op.
//
// 사용: worker/index.ts 최상단에서 `import "./load-env";` (다른 모듈보다 먼저)
import { config } from "dotenv";

config({ path: ".env.local" });
