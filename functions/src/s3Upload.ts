import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-2" });
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "usa-all-benefits-bucket";

export async function uploadToS3(
  buffer: Buffer,
  originalName: string,
  mimetype: string,
  prefix: string = "files/"
): Promise<string> {
  const ext = originalName.split(".").pop() || "jpg";
  const key = `${prefix}${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${ext}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
      ACL: "public-read" as any,
    })
  );

  return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || "us-east-2"}.amazonaws.com/${key}`;
}

export async function uploadImageToS3(
  buffer: Buffer,
  originalName: string,
  mimetype: string
): Promise<string> {
  return uploadToS3(buffer, originalName, mimetype, "recommendations/");
}
