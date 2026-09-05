<script setup lang="ts">
import { ref } from "vue";
import { apiPatch, apiPost, uploadAttachment } from "../../api";
import PageHeader from "../../components/layout/PageHeader.vue";
import PasswordStrength from "../../components/PasswordStrength.vue";
import Avatar from "../../components/ui/Avatar.vue";
import Button from "../../components/ui/Button.vue";
import Card from "../../components/ui/Card.vue";
import Input from "../../components/ui/Input.vue";
import Textarea from "../../components/ui/Textarea.vue";
import { useAuthStore } from "../../stores/authStore";

const authStore = useAuthStore();

const displayName = ref(authStore.user?.displayName || "");
const description = ref(authStore.user?.description || "");
const msg = ref("");
// P1-13：消息分性（true=成功绿 / false=失败红）——「保存失败」等不再恒绿渲染
const msgOk = ref(false);

const avatarUrl = ref((authStore.user as any)?.avatarUrl || "");
const avatarUploading = ref(false);
const avatarInputRef = ref<HTMLInputElement | null>(null);

const oldPw = ref("");
const newPw = ref("");
const showPw = ref(false);
const pwMsg = ref("");
// P1-13：同上，密码卡消息分性
const pwOk = ref(false);

function onAvatarFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) void handleAvatar(input.files[0]);
  input.value = "";
}

async function handleAvatar(file: File) {
  if (file.size > 10 * 1024 * 1024) {
    msg.value = "头像不能超过 10MB";
    msgOk.value = false;
    return;
  }
  avatarUploading.value = true;
  msg.value = "";
  try {
    const up = await uploadAttachment(file);
    await apiPatch("/api/profile", { avatarUrl: up.url });
    avatarUrl.value = up.url;
    authStore.updateUser({ avatarUrl: up.url } as any);
    msg.value = "头像已更新";
    msgOk.value = true;
  } catch {
    msg.value = "头像上传失败";
    msgOk.value = false;
  } finally {
    avatarUploading.value = false;
  }
}

async function handleSaveProfile() {
  try {
    await apiPatch("/api/profile", { displayName: displayName.value, description: description.value });
    msg.value = "已保存";
    msgOk.value = true;
    authStore.updateUser({ displayName: displayName.value, description: description.value });
  } catch {
    msg.value = "保存失败";
    msgOk.value = false;
  }
}

async function handleChangePassword() {
  if (newPw.value.length < 8) {
    pwMsg.value = "新密码至少 8 位";
    pwOk.value = false;
    return;
  }
  try {
    await apiPost("/api/profile/change-password", { oldPassword: oldPw.value, newPassword: newPw.value });
    pwMsg.value = "密码已修改，其他设备需重新登录";
    pwOk.value = true;
    oldPw.value = "";
    newPw.value = "";
  } catch (err: any) {
    pwMsg.value = err.message || "修改失败";
    pwOk.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="个人资料" back-to="/settings" />

    <Card class="w-full">
      <div class="mx-auto max-w-lg space-y-4">
        <div class="flex items-center gap-4">
          <Avatar :name="authStore.user?.handle || '?'" :src="avatarUrl" size="xl" />
          <div>
            <input
              ref="avatarInputRef"
              type="file"
              accept="image/*"
              class="hidden"
              @change="onAvatarFileChange"
            />
            <Button @click="avatarInputRef?.click()" :disabled="avatarUploading" size="sm" variant="secondary">
              {{ avatarUploading ? "上传中…" : "更换头像" }}
            </Button>
            <p class="mt-1 text-xs text-muted">支持 JPG/PNG，最大 10MB</p>
          </div>
        </div>
        <div>
          <label class="mb-1 block text-sm text-subtle">用户名 (不可修改)</label>
          <Input type="text" :value="authStore.user?.handle || ''" disabled />
        </div>
        <div>
          <label class="mb-1 block text-sm text-subtle">显示名</label>
          <Input type="text" :value="displayName" @input="displayName = ($event.target as HTMLInputElement).value" />
        </div>
        <div>
          <label class="mb-1 block text-sm text-subtle">简介</label>
          <Textarea :value="description" @input="description = ($event.target as HTMLTextAreaElement).value" rows="3" />
        </div>
        <Button @click="handleSaveProfile" size="sm">保存</Button>
        <!-- P1-13：按消息性质配色（成功 green / 失败 red），失败不再恒绿 -->
        <p v-if="msg" :class="['text-sm', msgOk ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400']">
          {{ msg }}
        </p>
      </div>
    </Card>

    <Card class="w-full">
      <div class="mx-auto max-w-lg space-y-4">
        <h3 class="font-semibold text-ink">修改密码</h3>
        <Input :type="showPw ? 'text' : 'password'" :value="oldPw" @input="oldPw = ($event.target as HTMLInputElement).value" placeholder="当前密码" />
        <div>
          <div class="relative">
            <Input
              :type="showPw ? 'text' : 'password'"
              :value="newPw"
              @input="newPw = ($event.target as HTMLInputElement).value"
              placeholder="新密码 (至少 8 位)"
              class="pr-10"
            />
            <button
              type="button"
              @click="showPw = !showPw"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-gray-600 dark:hover:text-gray-200"
            >
              {{ showPw ? "🙈" : "👁" }}
            </button>
          </div>
          <PasswordStrength :password="newPw" />
        </div>
        <Button @click="handleChangePassword" size="sm">修改密码</Button>
        <p v-if="pwMsg" :class="['text-sm', pwOk ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400']">
          {{ pwMsg }}
        </p>
      </div>
    </Card>
  </div>
</template>
