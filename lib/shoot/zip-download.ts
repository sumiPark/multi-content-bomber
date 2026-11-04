import { downloadZip } from "client-zip";

// 전체 ZIP 받기 — 브라우저가 파일을 하나씩 읽어 바로 묶는다. 촬영 원본이 커서 서버(Vercel 60초 제한)에서 묶을 수 없다.
// 저장 위치를 고를 수 있는 브라우저(크롬 · 엣지 PC)는 메모리에 쌓지 않고 디스크로 바로 쓴다.
// 그 밖의 브라우저는 메모리에 다 담은 뒤 저장해서, 파일이 아주 크면 실패할 수 있다.

interface SaveHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

type SavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;

export interface ZipEntry {
  name: string;
  url?: string;
  content?: string;
}

async function* entries(files: ZipEntry[], onFile: (name: string) => void) {
  for (const f of files) {
    onFile(f.name);
    if (f.content != null) {
      yield { name: f.name, input: f.content };
      continue;
    }
    const res = await fetch(f.url as string);
    if (!res.ok) throw new Error(`${f.name}을 읽지 못했어요 (${res.status}).`);
    yield { name: f.name, input: res };
  }
}

/** 사람이 저장 창을 취소하면 false. */
export async function saveZip(zipName: string, files: ZipEntry[], onFile: (name: string) => void): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    let handle: SaveHandle;
    try {
      handle = await picker({ suggestedName: zipName, types: [{ description: "ZIP 파일", accept: { "application/zip": [".zip"] } }] });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return false;
      throw e;
    }
    const body = downloadZip(entries(files, onFile)).body;
    if (!body) throw new Error("ZIP을 만들지 못했어요.");
    await body.pipeTo(await handle.createWritable());
    return true;
  }
  const blob = await downloadZip(entries(files, onFile)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
