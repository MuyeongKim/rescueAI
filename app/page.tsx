import { redirect } from "next/navigation";

// 루트는 학습자 홈으로. 미인증 사용자는 middleware가 /login 으로 리다이렉트한다.
export default function Home() {
  redirect("/home");
}
