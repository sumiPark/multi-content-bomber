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
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/");

  return (
    <Card>
      <CardHeader>
        <CardTitle>회원가입</CardTitle>
        <CardDescription>
          가입 후 워크스페이스를 만들거나 초대 토큰으로 합류하세요.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignupForm />
      </CardContent>
      <CardFooter className="text-sm">
        <span className="text-muted-foreground">이미 계정이 있으신가요?</span>
        <Link
          href="/login"
          className="ml-1 font-medium underline-offset-4 hover:underline"
        >
          로그인
        </Link>
      </CardFooter>
    </Card>
  );
}
