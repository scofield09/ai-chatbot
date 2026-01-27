"use client";

import {
  type ChangeEvent,
  memo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import type { Attachment } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "./ui/dialog";
import { PaperclipIcon } from "./icons";

type AttachmentsButtonProps = {
  status: "ready" | "submitted" | "streaming" | "error";
  selectedModelId: string;
  onFileUploaded?: (attachment: Attachment) => void;
};

function PureAttachmentsButton({
  status,
  selectedModelId,
  onFileUploaded,
}: AttachmentsButtonProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"image" | "file">("image");
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const isReasoningModel =
    selectedModelId.includes("reasoning") || selectedModelId.includes("think");

  const uploadFile = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/files/upload", {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        const { url, pathname, contentType } = data;

        return {
          url,
          name: pathname,
          contentType,
        };
      }
      const { error } = await response.json();
      toast.error(error || "上传失败");
    } catch (_error) {
      toast.error("上传失败，请重试");
    }
  };

  const handleImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // 验证文件类型
    const allowedTypes = ["image/jpeg", "image/png"];
    if (!allowedTypes.includes(file.type)) {
      toast.error("只支持 JPEG、PNG 格式");
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
      return;
    }

    // 验证文件大小（1MB）
    if (file.size > 1 * 1024 * 1024) {
      toast.error("文件大小不能超过 5MB");
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
      return;
    }

    setIsUploading(true);

    try {
      const uploadedAttachment = await uploadFile(file);
      
      if (uploadedAttachment) {
        onFileUploaded?.(uploadedAttachment);
        toast.success("图片上传成功");
        setOpen(false);
      }
    } catch (error) {
      console.error("Error uploading image!", error);
    } finally {
      setIsUploading(false);
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    // 验证文件类型
    const allowedTypes = ["application/pdf", "text/plain", "text/markdown"];
    if (!allowedTypes.includes(file.type)) {
      toast.error("只支持 PDF、TXT、MD 格式");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    // 验证文件大小（500KB）
    if (file.size > 500 * 1024) {
      toast.error("文件大小不能超过 500KB");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    setIsUploading(true);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/files/newUpload", {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        const { url, pathname, contentType, fileId } = data;

        const attachment = {
          url,
          name: pathname,
          contentType,
          fileId,
        };

        onFileUploaded?.(attachment);
        toast.success("文件上传成功");
        setOpen(false);
      } else {
        const { error } = await response.json();
        toast.error(error || "上传失败");
      }
    } catch (error) {
      console.error("Error uploading file!", error);
      toast.error("上传失败，请重试");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isUploading) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    if (isUploading) return;

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    if (activeTab === "image") {
      // 验证文件类型
      const allowedTypes = ["image/jpeg", "image/png"];
      if (!allowedTypes.includes(file.type)) {
        toast.error("只支持 JPEG、PNG 格式");
        return;
      }

      // 验证文件大小（5MB）
      if (file.size > 5 * 1024 * 1024) {
        toast.error("文件大小不能超过 5MB");
        return;
      }

      setIsUploading(true);

      try {
        const uploadedAttachment = await uploadFile(file);
        
        if (uploadedAttachment) {
          onFileUploaded?.(uploadedAttachment);
          toast.success("图片上传成功");
          setOpen(false);
        }
      } catch (error) {
        console.error("Error uploading image!", error);
      } finally {
        setIsUploading(false);
      }
    } else {
      // 验证文件类型
      const allowedTypes = ["application/pdf", "text/plain", "text/markdown"];
      if (!allowedTypes.includes(file.type)) {
        toast.error("只支持 PDF、TXT、MD 格式");
        return;
      }

      // 验证文件大小（500KB）
      if (file.size > 500 * 1024) {
        toast.error("文件大小不能超过 500KB");
        return;
      }

      setIsUploading(true);

      const formData = new FormData();
      formData.append("file", file);

      try {
        const response = await fetch("/api/files/newUpload", {
          method: "POST",
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          const { url, pathname, contentType, fileId } = data;

          const attachment = {
            url,
            name: pathname,
            contentType,
            fileId,
          };

          onFileUploaded?.(attachment);
          toast.success("文件上传成功");
          setOpen(false);
        } else {
          const { error } = await response.json();
          toast.error(error || "上传失败");
        }
      } catch (error) {
        console.error("Error uploading file!", error);
        toast.error("上传失败，请重试");
      } finally {
        setIsUploading(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-accent"
          data-testid="attachments-button"
          disabled={status !== "ready" || isReasoningModel}
          variant="ghost"
        >
          <PaperclipIcon size={14} style={{ width: 14, height: 14 }} />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md p-0">
        <div className="flex flex-col">
          {/* Tab 切换 */}
          <div className="flex border-b">
            <button
              type="button"
              onClick={() => setActiveTab("image")}
              className={cn(
                "flex-1 px-4 py-3 text-sm font-medium transition-colors",
                "hover:bg-accent",
                activeTab === "image"
                  ? "border-b-2 border-primary text-primary"
                  : "text-muted-foreground"
              )}
            >
              上传图片
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("file")}
              className={cn(
                "flex-1 px-4 py-3 text-sm font-medium transition-colors",
                "hover:bg-accent",
                activeTab === "file"
                  ? "border-b-2 border-primary text-primary"
                  : "text-muted-foreground"
              )}
            >
              上传文件
            </button>
          </div>

          {/* 上传区域 */}
          <div className="p-6">
            <label
              htmlFor={activeTab === "image" ? "image-upload" : "file-upload"}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={cn(
                "flex flex-col items-center justify-center w-full h-40 border-2 border-dashed rounded-lg cursor-pointer transition-colors",
                isUploading
                  ? "border-muted bg-muted/50 cursor-not-allowed"
                  : isDragging
                    ? "border-primary bg-primary/10"
                    : "border-border bg-background hover:bg-accent hover:border-accent-foreground/20"
              )}
            >
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                {isUploading ? (
                  <>
                    <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-2" />
                    <p className="mb-2 text-sm text-muted-foreground">
                      上传中...
                    </p>
                  </>
                ) : (
                  <>
                    <PaperclipIcon className="w-10 h-10 mb-3 text-muted-foreground" />
                    <p className="mb-2 text-sm text-muted-foreground">
                      <span className="font-semibold">点击选择</span> 或拖拽到此处
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {activeTab === "image"
                        ? "JPEG, PNG (最大 5MB)"
                        : "PDF, TXT, MD (最大 500KB)"}
                    </p>
                  </>
                )}
              </div>
              {activeTab === "image" ? (
                <input
                  id="image-upload"
                  ref={imageInputRef}
                  accept="image/jpeg,image/png"
                  className="hidden"
                  disabled={isUploading}
                  onChange={handleImageChange}
                  type="file"
                />
              ) : (
                <input
                  id="file-upload"
                  ref={fileInputRef}
                  accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                  className="hidden"
                  disabled={isUploading}
                  onChange={handleFileChange}
                  type="file"
                />
              )}
            </label>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const AttachmentsCustomButton = memo(PureAttachmentsButton);
