import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/");

  return (
    <Card>
      <CardHeader>
        <CardTitle>로그인</CardTitle>
        <CardDescription>이메일과 비밀번호를 입력하세요.</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm />
      </CardContent>
      <CardFooter className="text-sm">
        <span className="text-muted-foreground">아직 계정이 없으신가요?</span>
        <Link
          href="/signup"
          className="ml-1 font-medium underline-offset-4 hover:underline"
        >
          회원가입
        </Link>
      </CardFooter>
    </Card>
  );
}
