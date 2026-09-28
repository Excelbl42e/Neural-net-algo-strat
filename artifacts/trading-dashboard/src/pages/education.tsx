import { useState, useRef } from "react";
import {
  useListEducationSources,
  useCreateEducationSource,
  useDeleteEducationSource,
  useIngestSource,
  useUploadSourceFile,
  useGetWorkerStatus,
  getListEducationSourcesQueryKey,
  getGetWorkerStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import {
  BookOpen,
  Youtube,
  ListVideo,
  FileText,
  Plus,
  Trash2,
  CircleDot,
  CheckCircle2,
  AlertCircle,
  Clock,
  Activity,
  RefreshCw,
  Upload,
  FileUp,
} from "lucide-react";

const formSchema = z.object({
  kind: z.enum(["book", "video", "playlist", "text"]),
  title: z.string().min(1, "Title is required"),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  contentText: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

const KIND_META: Record<string, { icon: any; color: string; label: string }> = {
  book:     { icon: BookOpen,   color: "text-amber-400 border-amber-500/30 bg-amber-500/10",   label: "Book / PDF / Image" },
  video:    { icon: Youtube,    color: "text-red-400 border-red-500/30 bg-red-500/10",         label: "Video" },
  playlist: { icon: ListVideo,  color: "text-fuchsia-400 border-fuchsia-500/30 bg-fuchsia-500/10", label: "Playlist" },
  text:     { icon: FileText,   color: "text-primary border-primary/30 bg-primary/10",         label: "Raw Text" },
};

const STATUS_META: Record<string, { icon: any; color: string }> = {
  pending:    { icon: Clock,        color: "text-amber-400" },
  processing: { icon: CircleDot,    color: "text-violet-400 animate-pulse" },
  ready:      { icon: CheckCircle2, color: "text-green-400" },
  partial:    { icon: AlertCircle,  color: "text-amber-400" },
  error:      { icon: AlertCircle,  color: "text-red-400" },
};

export default function Education() {
  const { data: sources, isLoading } = useListEducationSources();
  const { data: workerStatus } = useGetWorkerStatus({ query: { refetchInterval: 15000, queryKey: getGetWorkerStatusQueryKey() } });
  const [open, setOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadMutation = useUploadSourceFile({
    mutation: {
      onSuccess: () => {
        setUploading(false);
        queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() });
        toast({ title: "File uploaded", description: "Check source status below to confirm ingestion." });
        // Keep polling for status
        setTimeout(() => queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() }), 4000);
        setTimeout(() => queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() }), 10000);
        setTimeout(() => queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() }), 20000);
      },
      onError: (err: any) => {
        setUploading(false);
        toast({ title: "Upload failed", description: err?.message ?? "Unknown error", variant: "destructive" });
      },
    },
  });

  const createMutation = useCreateEducationSource({
    mutation: {
      onSuccess: (created: any) => {
        queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() });

        if (selectedFile) {
          setUploading(true);
          setOpen(false);
          toast({ title: "Source created", description: "Uploading file now…" });
          uploadMutation.mutate({ id: created.id, data: { file: selectedFile } } as any);
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        } else {
          toast({ title: "Source added", description: "Check source status; processing may still be pending." });
          setOpen(false);
          setTimeout(() => queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() }), 3000);
          setTimeout(() => queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() }), 8000);
        }
      },
      onError: (err: any) => {
        toast({ title: "Failed to add source", description: err?.message ?? "Unknown error", variant: "destructive" });
      },
    },
  });

  const deleteMutation = useDeleteEducationSource({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() });
        toast({ title: "Source removed" });
      },
    },
  });

  const ingestMutation = useIngestSource({
    mutation: {
      onSuccess: (_data, vars) => {
        queryClient.invalidateQueries({ queryKey: getListEducationSourcesQueryKey() });
        toast({ title: "Ingestion complete", description: `Source ${(vars as any).id} processed.` });
      },
      onError: (err: any) => {
        toast({ title: "Ingestion failed", description: err?.message ?? "Unknown error", variant: "destructive" });
      },
    },
  });


  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { kind: "book", title: "", author: "", sourceUrl: "", contentText: "" },
  });

  const kind = form.watch("kind");

  const onSubmit = (values: FormValues) => {
    const clean: any = { kind: values.kind, title: values.title };
    if (values.author?.trim()) clean.author = values.author.trim();
    if (values.sourceUrl?.trim()) clean.sourceUrl = values.sourceUrl.trim();
    if (values.contentText?.trim()) clean.contentText = values.contentText.trim();
    createMutation.mutate({ data: clean });
  };

  const list = sources ?? [];

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-wider">Education / Knowledge Base</h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono-numbers">
            Source ingestion status and stored chunk counts. A ready source does not imply model training.
          </p>
        </div>

        <div className="flex items-center gap-2">

          <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" /> Add Knowledge Source
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Knowledge Source</DialogTitle>
              <DialogDescription>
                Create a source, then check its processing status and stored chunk/vector counts below.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={kind} onValueChange={(v) => form.setValue("kind", v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="book">Book / PDF / Image</SelectItem>
                    <SelectItem value="video">YouTube Video</SelectItem>
                    <SelectItem value="playlist">YouTube Playlist</SelectItem>
                    <SelectItem value="text">Raw Text</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Title *</Label>
                <Input {...form.register("title")} placeholder="e.g. The Inner Circle Trader Mentorship 2022" />
                {form.formState.errors.title && (
                  <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
                )}
              </div>

              {(kind === "book") && (
                <div className="space-y-2">
                  <Label>Author</Label>
                  <Input {...form.register("author")} placeholder="e.g. Michael J. Huddleston" />
                </div>
              )}

              {kind === "book" && (
                <div className="space-y-3">
                  {/* File upload zone */}
                  <div className="space-y-2">
                    <Label>Upload file <span className="text-muted-foreground text-xs font-normal">(PDF or image)</span></Label>
                    <div
                      className={cn(
                        "border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors",
                        selectedFile
                          ? "border-violet-500/60 bg-violet-500/5"
                          : "border-border hover:border-primary/40 hover:bg-primary/5"
                      )}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,application/pdf,image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          setSelectedFile(f);
                        }}
                      />
                      {selectedFile ? (
                        <div className="flex items-center justify-center gap-2 text-violet-300">
                          <FileUp className="w-5 h-5" />
                          <span className="text-sm font-medium truncate max-w-[260px]">{selectedFile.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ({(selectedFile.size / 1024 / 1024).toFixed(1)} MB)
                          </span>
                        </div>
                      ) : (
                        <div className="text-muted-foreground">
                          <Upload className="w-7 h-7 mx-auto mb-2 opacity-50" />
                          <p className="text-sm font-medium">Click to select a PDF or image</p>
                          <p className="text-xs mt-1 opacity-70">PDF, JPG, PNG, WEBP — up to 100 MB</p>
                          <p className="text-xs mt-0.5 opacity-50">Photos of book pages are read by GPT-4 Vision and fully transcribed</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* OR divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">or provide a URL</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  <div className="space-y-2">
                    <Input
                      {...form.register("sourceUrl")}
                      placeholder="https://… remote PDF URL"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Paste excerpt (optional)</Label>
                    <Textarea
                      {...form.register("contentText")}
                      rows={3}
                      placeholder="Paste a chapter or excerpt if you have the text handy…"
                    />
                  </div>
                </div>
              )}

              {(kind === "video" || kind === "playlist") && (
                <div className="space-y-2">
                  <Label>{kind === "video" ? "YouTube URL" : "YouTube playlist URL"}</Label>
                  <Input
                    {...form.register("sourceUrl")}
                    placeholder="https://www.youtube.com/…"
                  />
                </div>
              )}

              {kind === "text" && (
                <div className="space-y-2">
                  <Label>Text content *</Label>
                  <Textarea
                    {...form.register("contentText")}
                    rows={6}
                    placeholder="Paste source text to store and process…"
                  />
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => {
                  setOpen(false);
                  setSelectedFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="gap-2"
                >
                  {createMutation.isPending
                    ? (selectedFile ? "Creating…" : "Adding…")
                    : selectedFile
                      ? <><Upload className="w-3.5 h-3.5" /> Upload & Ingest</>
                      : "Add to knowledge base"
                  }
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Upload progress banner */}
      {uploading && (
        <div className="border border-violet-500/40 bg-violet-500/10 rounded-lg p-4 flex items-center gap-4">
          <div className="flex items-center gap-2 text-violet-300 shrink-0">
            <Upload className="w-4 h-4 animate-bounce" />
            <span className="text-sm font-medium">Uploading file to the source endpoint…</span>
          </div>
          <div className="flex-1">
            <Progress className="h-1.5 bg-violet-500/20 [&>div]:bg-violet-400" value={undefined} />
          </div>
          <span className="text-xs text-muted-foreground shrink-0 font-mono-numbers">processing</span>
        </div>
      )}

      {/* Worker status strip */}
      {workerStatus && (
        <div className="border border-violet-500/20 bg-violet-500/5 rounded-lg p-3 flex flex-wrap items-center gap-4 text-[11px] font-mono-numbers">
          <div className={cn("flex items-center gap-1.5", workerStatus.running ? "text-violet-300" : "text-muted-foreground")}>
            <span className={cn("w-2 h-2 rounded-full", workerStatus.running ? "bg-violet-400 animate-pulse" : "bg-muted-foreground/40")} />
            <span className="uppercase tracking-wider font-bold">{workerStatus.running ? "SIGNAL WORKER ACTIVE" : "SIGNAL WORKER IDLE"}</span>
          </div>
          <span className="text-muted-foreground/60">|</span>
          <span className="text-muted-foreground">Signals generated (worker counter; not fills): <span className="text-foreground">{workerStatus.signalsGeneratedTotal}</span></span>
          <span className="text-muted-foreground/60">|</span>
          <span className="text-muted-foreground">Cycle: <span className="text-foreground">{Math.round((workerStatus.intervalMs ?? 300000) / 60000)}min</span></span>
          {workerStatus.lastRunAt && (
            <>
              <span className="text-muted-foreground/60">|</span>
              <span className="text-muted-foreground">Last run: <span className="text-foreground">{new Date(workerStatus.lastRunAt).toLocaleTimeString()}</span></span>
            </>
          )}
          {workerStatus.lastError && (
            <span className="text-red-400 ml-auto truncate max-w-[240px]">Error: {workerStatus.lastError}</span>
          )}
        </div>
      )}

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Total Sources" value={list.length} color="text-primary" />
        <StatTile label="Ready" value={list.filter(s => s.status === "ready").length} color="text-green-400" />
        <StatTile label="Processing" value={list.filter(s => s.status === "processing").length} color="text-violet-400" />
        <StatTile label="Partial" value={list.filter(s => s.status === "partial").length} color="text-amber-400" />
        <StatTile label="Pending" value={list.filter(s => s.status === "pending").length} color="text-amber-400" />
      </div>

      {/* Source list */}
      <div className="space-y-3">
        {isLoading ? (
          Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)
        ) : list.length === 0 ? (
          <div className="border border-dashed border-border rounded-xl p-12 text-center">
            <BookOpen className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium">No knowledge sources yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add sources to the knowledge store. Check each source's status before relying on it.
            </p>
          </div>
        ) : (
          list.map((s) => {
            const meta = KIND_META[s.kind] ?? KIND_META.text;
            const KindIcon = meta.icon;
            const statusMeta = STATUS_META[s.status] ?? STATUS_META.pending;
            const StatusIcon = statusMeta.icon;
            return (
              <div key={s.id} className="border border-border rounded-xl bg-card p-4 hover:border-primary/30 transition-colors">
                <div className="flex items-start gap-4">
                  <div className={cn("w-10 h-10 rounded-lg border flex items-center justify-center shrink-0", meta.color)}>
                    <KindIcon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn("text-[10px] font-mono-numbers uppercase tracking-wider px-1.5 py-0.5 rounded border", meta.color)}>
                        {meta.label}
                      </span>
                      <h3 className="font-semibold truncate">{s.title}</h3>
                      {s.author && <span className="text-xs text-muted-foreground">— {s.author}</span>}
                    </div>
                    {s.sourceUrl && (
                      <a
                        href={s.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary/70 hover:text-primary truncate block mt-0.5 font-mono-numbers"
                      >
                        {s.sourceUrl}
                      </a>
                    )}
                    {s.transcriptPreview && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2 italic">
                        "{s.transcriptPreview}"
                      </p>
                    )}
                    <div className="flex items-center gap-4 mt-3 text-[10px] font-mono-numbers text-muted-foreground">
                      <div className={cn("flex items-center gap-1", statusMeta.color)}>
                        <StatusIcon className="w-3 h-3" />
                        <span className="uppercase tracking-wider">{s.status}</span>
                      </div>
                      <span>Chunks: <span className="text-foreground">{s.chunksCount}</span></span>
                      <span>Vectors: <span className="text-foreground">{s.vectorCount}</span></span>
                      <span className="ml-auto text-muted-foreground/60">
                        {new Date(s.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {s.errorMessage && (
                      <p className="text-xs text-red-400 mt-2 font-mono-numbers">{s.errorMessage}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-1">
                    {s.status !== "processing" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => ingestMutation.mutate({ id: s.id } as any)}
                        disabled={ingestMutation.isPending}
                        className="h-8 px-2 text-xs text-violet-400 hover:bg-violet-500/10 gap-1"
                        title="Re-process this source now"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Process
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => { if (window.confirm(`Delete source "${s.title}"? This cannot be undone.`)) deleteMutation.mutate({ id: s.id }); }}
                      disabled={deleteMutation.isPending}
                      className="text-muted-foreground hover:text-destructive h-8 w-8"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Engine note */}
      <div className="border border-violet-500/20 bg-violet-500/5 rounded-lg p-3 text-[11px] font-mono-numbers text-violet-300/70">
        <p className="font-bold uppercase tracking-wider text-violet-300 mb-1">Source processing</p>
        Sources may remain <span className="text-amber-300">pending</span> until ingestion succeeds.
        Use the reported status, chunk count, vector count and error message above to assess each source.
      </div>
    </div>
  );
}

function StatTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="border border-border rounded-lg bg-card p-3">
      <div className="text-[10px] font-mono-numbers text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={cn("text-2xl font-bold font-mono-numbers mt-1", color)}>{value}</div>
    </div>
  );
}
