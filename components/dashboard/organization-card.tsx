import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Database } from "@/types/database";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type Organization = Database["public"]["Tables"]["organizations"]["Row"];

const roleStyle: Record<Profile["role"], string> = {
  ADMIN: "bg-violet-500 hover:bg-violet-500 text-white",
  MANAGER: "bg-blue-500 hover:bg-blue-500 text-white",
  STAFF: "bg-zinc-500 hover:bg-zinc-500 text-white",
};

interface OrganizationCardProps {
  profile: Pick<Profile, "role" | "full_name" | "email">;
  organization: Pick<Organization, "id" | "name" | "created_at">;
}

export function OrganizationCard({
  profile,
  organization,
}: OrganizationCardProps) {
  const createdAt = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "long",
  }).format(new Date(organization.created_at));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-xl">{organization.name}</CardTitle>
            <CardDescription>{createdAt} 생성</CardDescription>
          </div>
          <Badge className={roleStyle[profile.role]}>{profile.role}</Badge>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {profile.full_name ?? profile.email ?? "이름 미설정"} 님으로 접속 중
      </CardContent>
    </Card>
  );
}
