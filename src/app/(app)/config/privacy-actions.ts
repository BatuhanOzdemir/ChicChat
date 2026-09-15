"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/db/client";
import { currentMerchantId } from "@/server/merchant/current";
import { eraseCustomer } from "@/db/privacy";

export async function deleteCustomerData(form: FormData): Promise<void> {
  const db = getDatabase();
  const merchantId = await currentMerchantId(db);
  const phone = String(form.get("phone") ?? "").trim();
  if (
    !merchantId ||
    !/^\d{7,15}$/.test(phone) ||
    form.get("confirm") !== "delete"
  ) {
    redirect("/config?error=Enter+a+valid+phone+number+and+confirm+deletion");
  }
  await eraseCustomer(db, merchantId, phone);
  revalidatePath("/", "layout");
  redirect("/config?erased=1");
}
