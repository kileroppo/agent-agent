const { createApp, ref, computed, onMounted } = Vue

createApp({
  setup() {
    const state = {
      view: ref('dashboard'),
      dashboard: ref(null),
      works: ref([]),
      analysis: ref([]),
      selected: ref(null),
      loading: ref(false),
      settings: ref(null),
      settingsDraft: ref({ analysis_auto_enabled: false, analysis_auto_grades: 'T2,T3' }),
      settingsLoading: ref(false),
      settingsMessage: ref(''),
      filters: {
        grade: ref(''),
        platform: ref(''),
        creatorId: ref(''),
      },
      importPayload: ref(''),
      importResult: ref(''),
      sourceUrl: ref(''),
      collectResult: ref(null),
      collectLoading: ref(false),
    }

    const gradeClass = (grade = 'N0') => ({
      T3: 'badge-T3',
      T2: 'badge-T2',
      T1: 'badge-T1',
      N0: 'badge-N0',
    }[grade] || 'badge-N0')

    const fmt = (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'

    const api = async (path, opt = {}) => {
      const r = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...opt,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        throw new Error(data.detail || data.error || '请求失败')
      }
      return data
    }

    const loadDashboard = async () => {
      state.dashboard.value = await api('/api/dashboard')
    }

    const loadWorks = async () => {
      state.loading.value = true
      try {
        const q = new URLSearchParams()
        if (state.filters.grade.value) q.set('grade', state.filters.grade.value)
        if (state.filters.platform.value) q.set('platform', state.filters.platform.value)
        if (state.filters.creatorId.value) q.set('creator_id', state.filters.creatorId.value)
        const data = await api(`/api/works?${q.toString()}`)
        state.works.value = data.works || []
      } finally {
        state.loading.value = false
      }
    }

    const loadDetail = async (id) => {
      state.selected.value = await api(`/api/works/${id}`)
    }

    const runScan = async () => {
      await api('/api/scan/run', { method: 'POST' })
      await runWorkerOnce()
      await loadWorks()
    }

    const dispatchAnalysis = async () => {
      await api('/api/analysis/run', { method: 'POST' })
      if (state.view.value === 'dashboard') {
        await loadDashboard()
      }
      if (state.view.value === 'analysis') {
        await loadAnalysis()
      }
    }

    const loadAnalysis = async () => {
      const data = await api('/api/analysis')
      state.analysis.value = data.items || []
    }

    const loadSettings = async () => {
      state.settingsLoading.value = true
      try {
        const data = await api('/api/settings')
        const config = data.analysis_auto || {}
        state.settings.value = config
        state.settingsDraft.value = {
          analysis_auto_enabled: !!config.enabled,
          analysis_auto_grades: Array.isArray(config.grades)
            ? config.grades.join(',')
            : 'T2,T3',
        }
      } finally {
        state.settingsLoading.value = false
      }
    }

    const saveSettings = async () => {
      const grades = String(state.settingsDraft.value.analysis_auto_grades || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .join(',')
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          analysis_auto_enabled: !!state.settingsDraft.value.analysis_auto_enabled,
          analysis_auto_grades: grades,
        }),
      })
      state.settingsMessage.value = '保存成功'
      await loadSettings()
      window.setTimeout(() => {
        state.settingsMessage.value = ''
      }, 1200)
    }

    const runWorkerOnce = async () => {
      await api('/api/analysis/process', { method: 'POST' })
    }

    const enqueuePlatform = async (platform) => {
      await api(`/api/scan/enqueue/${platform}`, { method: 'POST' })
    }

    const submitImport = async () => {
      if (!state.importPayload.value) return
      const payload = JSON.parse(state.importPayload.value)
      const body = {
        source_type: 'manual',
        platform: 'douyin',
        ...payload,
      }
      state.importResult.value = JSON.stringify(
        await api('/api/import', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        null,
        2
      )
      await loadWorks()
      await loadDashboard()
    }

    const collectUrl = async () => {
      const url = String(state.sourceUrl.value || '').trim()
      if (!url) return
      state.collectLoading.value = true
      state.collectResult.value = null
      try {
        state.collectResult.value = await api('/api/collect/url', {
          method:'POST',
          body:JSON.stringify({ url, history_limit:20 }),
        })
        await Promise.all([loadWorks(), loadDashboard()])
      } catch (error) {
        state.collectResult.value = { status:'failed', message:error.message }
      } finally {
        state.collectLoading.value = false
      }
    }

    const start = async () => {
      await Promise.all([loadDashboard(), loadWorks(), loadSettings()])
    }

    onMounted(start)

    const booms = computed(() => (state.dashboard.value ? state.dashboard.value.boom : {}))

    return {
      state,
      gradeClass,
      fmt,
      loadWorks,
      loadDetail,
      runScan,
      dispatchAnalysis,
      runWorkerOnce,
      loadAnalysis,
      loadSettings,
      saveSettings,
      enqueuePlatform,
      submitImport,
      collectUrl,
      start,
      booms,
    }
  },
  template: `
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold">爆款监控系统</h1>
        <div class="space-x-2">
          <button @click="state.view='dashboard'" class="px-3 py-1.5 rounded bg-slate-900 text-white">Dashboard</button>
          <button @click="state.view='works'" class="px-3 py-1.5 rounded bg-slate-200">作品看板</button>
          <button @click="state.view='analysis'; loadAnalysis()" class="px-3 py-1.5 rounded bg-slate-200">军团派发</button>
          <button @click="state.view='import'" class="px-3 py-1.5 rounded bg-slate-200">导入</button>
          <button @click="state.view='settings'" class="px-3 py-1.5 rounded bg-slate-200">设置</button>
        </div>
      </div>

      <section class="grid md:grid-cols-4 gap-3">
        <div class="bg-white p-4 rounded-xl shadow">创作者 {{ state.dashboard?.totals?.creators || 0 }}</div>
        <div class="bg-white p-4 rounded-xl shadow">作品 {{ state.dashboard?.totals?.works || 0 }}</div>
        <div class="bg-white p-4 rounded-xl shadow">T3 {{ booms.value.T3 || 0 }}</div>
        <div class="bg-white p-4 rounded-xl shadow">T2 {{ booms.value.T2 || 0 }}</div>
      </section>

      <section v-if="state.view==='dashboard'" class="bg-white rounded-xl p-4 space-y-3">
        <h2 class="font-semibold text-lg">粘贴链接判断值不值得拆</h2>
        <p class="text-sm text-slate-500">支持小红书、抖音。系统会读取当前指标、作者粉丝和最多 20 条历史作品，再用现有 R/M 算法评级。</p>
        <div class="flex gap-2">
          <input v-model="state.sourceUrl.value" class="flex-1 border rounded px-3 py-2" placeholder="粘贴小红书或抖音作品链接" />
          <button class="px-4 py-2 rounded bg-slate-900 text-white disabled:opacity-50" @click="collectUrl" :disabled="state.collectLoading.value">
            {{ state.collectLoading.value ? '正在读取…' : '判断并评分' }}
          </button>
        </div>
        <div v-if="state.collectResult.value" class="rounded-lg bg-slate-50 p-3 text-sm">
          <div>{{ state.collectResult.value.message }}</div>
          <div v-if="state.collectResult.value.score" class="mt-1">
            等级 <span class="badge" :class="gradeClass(state.collectResult.value.score.grade)">{{ state.collectResult.value.score.grade }}</span>
            · R {{ Number(state.collectResult.value.score.r_value || 0).toFixed(2) }}
            · M {{ Number(state.collectResult.value.score.m_value || 0).toFixed(4) }}
            · 历史样本 {{ state.collectResult.value.score.sample_count }} 条
          </div>
        </div>
        <h2 class="font-semibold text-lg pt-2">健康状态</h2>
        <div>待处理扫描任务: {{ state.dashboard?.scan_jobs || 0 }}</div>
        <div class="space-x-2 mt-2">
          <button class="px-3 py-1.5 rounded bg-emerald-100" @click="runScan">手动入队扫描</button>
          <button class="px-3 py-1.5 rounded bg-amber-100" @click="dispatchAnalysis">派发到小D / 小拆</button>
          <button class="px-3 py-1.5 rounded bg-slate-100" @click="loadDashboard">刷新</button>
        </div>
      </section>

      <section v-if="state.view==='works'" class="bg-white rounded-xl p-4">
        <div class="flex flex-wrap gap-2 mb-3">
          <select v-model="state.filters.grade.value" class="border rounded px-2 py-1">
            <option value="">全部</option>
            <option value="T1">T1</option>
            <option value="T2">T2</option>
            <option value="T3">T3</option>
            <option value="N0">N0</option>
          </select>
          <select v-model="state.filters.platform.value" class="border rounded px-2 py-1">
            <option value="">全部平台</option>
            <option value="douyin">抖音</option>
            <option value="xiaohongshu">小红书</option>
            <option value="youtube">YouTube</option>
          </select>
          <input v-model="state.filters.creatorId.value" placeholder="creator_id" class="border rounded px-2 py-1" />
          <button class="px-3 py-1.5 rounded bg-slate-900 text-white" @click="loadWorks">查询</button>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left border-b">
              <th class="py-2">作品</th><th>平台</th><th>分数(R/M)</th><th>等级</th><th>时间</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="state.loading" class="text-slate-400"><td colspan="6">加载中...</td></tr>
            <tr v-for="w in state.works" :key="w.id" class="border-b">
              <td class="py-2">{{ w.title || w.work_id }}</td>
              <td>{{ w.platform }}</td>
              <td>{{ Number(w.r_value||0).toFixed(2) }} / {{ Number(w.m_value||0).toFixed(4) }}</td>
              <td><span class="badge" :class="gradeClass(w.grade)">{{ w.grade }}</span></td>
              <td>{{ fmt(w.publish_at) }}</td>
              <td><button class="underline" @click="loadDetail(w.id)">详情</button></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="state.view==='analysis'" class="bg-white rounded-xl p-4">
        <h3 class="font-semibold mb-2">军团分析派发</h3>
        <p class="text-sm text-slate-500 mb-3">命中作品会进入现有“小D取证 → 小拆分析”任务链，不在雷达内重复调用模型。</p>
        <button class="mb-3 px-3 py-1.5 rounded bg-slate-900 text-white" @click="dispatchAnalysis">立即派发</button>
        <ol class="list-decimal pl-5 space-y-1">
          <li v-for="it in state.analysis" :key="it.id">
            {{ it.title || it.work_id }} · {{ it.tier }} · {{ it.analysis_depth }} · {{ it.status }}
            <span v-if="it.army_task_id"> · 军团任务 {{ it.army_task_id }}</span>
            <span v-if="it.dispatch_error" class="text-red-700"> · {{ it.dispatch_error }}</span>
          </li>
        </ol>
      </section>

      <section v-if="state.view==='import'" class="bg-white rounded-xl p-4">
        <h3 class="font-semibold mb-2">导入历史作品</h3>
        <textarea v-model="state.importPayload" class="w-full h-44 border rounded p-2" placeholder='{"platform":"douyin","creator_id":"xxx","creator_name":"name","follower_count":120000,"works":[{...}]}'></textarea>
        <div class="mt-2">
          <button class="px-3 py-1.5 rounded bg-emerald-700 text-white" @click="submitImport">提交导入</button>
        </div>
        <pre class="mt-3 bg-slate-100 p-3 text-xs overflow-auto">{{ state.importResult }}</pre>
      </section>

      <section v-if="state.view==='settings'" class="bg-white rounded-xl p-4">
        <h3 class="font-semibold mb-3">设置</h3>
        <div class="space-y-3 max-w-xl">
          <label class="flex items-center gap-2">
            <input type="checkbox" v-model="state.settingsDraft.value.analysis_auto_enabled" />
            <span>自动拆解命中的作品</span>
          </label>
          <label class="block">
            <div class="mb-1 text-sm">自动入队等级（逗号分隔）</div>
            <input
              v-model="state.settingsDraft.value.analysis_auto_grades"
              class="w-full border rounded px-2 py-1"
              placeholder="推荐 T2,T3"
            />
          </label>
          <div class="text-xs text-slate-500">
            当前配置: {{ state.settings.value ? ('enabled=' + state.settings.value.enabled + ', grades=' + (state.settings.value.grades || []).join(',')) : '-' }}
          </div>
          <div class="flex items-center gap-2">
            <button class="px-3 py-1.5 rounded bg-slate-900 text-white" @click="saveSettings" :disabled="state.settingsLoading.value">
              保存
            </button>
            <span class="text-sm text-emerald-700" v-if="state.settingsMessage.value">{{ state.settingsMessage.value }}</span>
          </div>
        </div>
      </section>

      <section v-if="state.selected && state.selected.work" class="bg-white rounded-xl p-4">
        <h3 class="font-semibold mb-2">详情</h3>
        <div>ID: {{ state.selected.work.id }}</div>
        <div>标题: {{ state.selected.work.title }}</div>
        <div>等级: <span class="badge" :class="gradeClass(state.selected.work.grade)">{{ state.selected.work.grade }}</span></div>
        <div>R: {{ Number(state.selected.work.r_value || 0).toFixed(4) }}</div>
        <div>M: {{ Number(state.selected.work.m_value || 0).toFixed(4) }}</div>
        <div>基线: {{ state.selected.work.baseline_metric }}</div>
        <div>军团派发: {{ state.selected.work.analysis_status }}</div>
      </section>
    </div>
  `,
}).mount('#app')
