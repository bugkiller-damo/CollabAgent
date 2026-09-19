<script setup lang="ts">
import { Eye, EyeOff } from "@lucide/vue";
import { ref } from "vue";
import { apiPatch, apiPost, uploadAttachment } from "../../api";
import PageHeader from "../../components/layout/PageHeader.vue";
import PasswordStrength from "../../components/PasswordStrength.vue";
import AvatarPresetPicker from "../../components/ui/AvatarPresetPicker.vue";
import Button from "../../components/ui/Button.vue";
import Card from "../../components/ui/Card.vue";
import Input from "../../components/ui/Input.vue";
import Textarea from "../../components/ui/Textarea.vue";
import { validatePasswordPolicy } from "../../lib/passwordPolicy";
import { useAuthStore } from "../../stores/authStore";
import { useChannelStore } from "../../stores/channelStore";

const authStore = useAuthStore();
const channelStore = useChannelStore();

// 自己的资料变更同步频道成员缓存——成员面板/消息行头像即时跟随（server 的
// profile:update 广播也会回投本人，幂等重放；这里本地先写不等回环）
function syncMemberCache(patch: { displayName?: string; avatarUrl?: string | null }) {
  const id = authStore.user?.id;
  if (!id) return;
  channelStore.applyMemberProfile({ memberType: "human", memberId: String(id), ...patch });
}

const displayName = ref(authStore.user?.displayName || "");
const description = ref(authStore.user?.description || "");
const msg = ref("");
// P1-13：消息分性（true=成功绿 / false=失败红）——「保存失败」等不再恒绿渲染
const msgOk = ref(false);

const avatarUrl = ref(authStore.user?.avatarUrl || "");
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
    authStore.updateUser({ avatarUrl: up.url });
    syncMemberCache({ avatarUrl: up.url });
    msg.value = "头像已更新";
    msgOk.value = true;
  } catch {
    msg.value = "头像上传失败";
    msgOk.value = false;
  } finally {
    avatarUploading.value = false;
  }
}

// 预设头像：url=""（字母格）时写 null，server 落 NULL → Avatar 回退彩色字母
async function selectPreset(url: string) {
  avatarUploading.value = true;
  msg.value = "";
  try {
    await apiPatch("/api/profile", { avatarUrl: url || null });
    avatarUrl.value = url;
    authStore.updateUser({ avatarUrl: url || null });
    syncMemberCache({ avatarUrl: url || null });
    msg.value = url ? "头像已更新" : "已恢复默认字母头像";
    msgOk.value = true;
  } catch {
    msg.value = "头像更新失败";
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
    syncMemberCache({ displayName: displayName.value });
  } catch {
    msg.value = "保存失败";
    msgOk.value = false;
  }
}

async function handleChangePassword() {
  // P1-14：对齐 server validatePassword（≥8+字母+数字），此前仅 ≥8——「abcdefgh」过客户端被 server 400
  const pwErr = validatePasswordPolicy(newPw.value);
  if (pwErr) {
    pwMsg.value = pwErr;
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
          <AvatarPresetPicker
            :current="avatarUrl"
            :letter-name="authStore.user?.handle || '?'"
            :disabled="avatarUploading"
            size="xl"
            @select="selectPreset"
          />
          <div>
            <input
              ref="avatarInputRef"
              type="file"
              accept="image/*"
              class="hidden"
              @change="onAvatarFileChange"
            />
            <Button @click="avatarInputRef?.click()" :disabled="avatarUploading" size="sm" variant="secondary">
              {{ avatarUploading ? "更新中…" : "上传照片" }}
            </Button>
            <p class="mt-1 text-xs text-muted">点击头像挑内置样式；支持 JPG/PNG，最大 10MB</p>
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
              placeholder="新密码 (至少 8 位，含字母和数字)"
              class="pr-10"
            />
            <button
              type="button"
              @click="showPw = !showPw"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-gray-600 dark:hover:text-gray-200"
            >
              <EyeOff v-if="showPw" class="h-4 w-4" />
              <Eye v-else class="h-4 w-4" />
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
