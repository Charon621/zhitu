import { useEffect, useState } from 'react'
import { getBootstrap, type Bootstrap } from './api'
import type { SettingsView } from './types'
import { Onboarding } from './screens/Onboarding'
import { Chat } from './screens/Chat'
import { useDialogFocus } from './components/useDialogFocus'

export function App(): React.JSX.Element {
  useDialogFocus()
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [fatal, setFatal] = useState('')

  useEffect(() => {
    void getBootstrap()
      .then((data) => {
        setBootstrap(data)
        setSettings(data.settings)
      })
      .catch((err: unknown) => {
        setFatal(err instanceof Error ? err.message : String(err))
      })
  }, [])

  if (fatal) {
    return (
      <div className="boot">
        <div className="boot-box">
          <div className="boot-title">织图没能启动</div>
          <p className="boot-text">{fatal}</p>
          <p className="boot-text dim">重启一下软件试试。如果一直这样，把这句话发给开发者。</p>
          <button className="btn primary" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </div>
    )
  }

  if (!bootstrap || !settings) {
    return (
      <div className="boot">
        <div className="boot-box">
          <div className="boot-title">织图</div>
          <p className="boot-text">正在准备…</p>
        </div>
      </div>
    )
  }

  if (!settings.onboarded) {
    return (
      <Onboarding
        bootstrap={bootstrap}
        onDone={(next) => {
          setSettings(next)
          setBootstrap({ ...bootstrap, settings: next })
        }}
      />
    )
  }

  return (
    <Chat
      bootstrap={bootstrap}
      settings={settings}
      onSettingsChanged={(next) => {
        setSettings(next)
        setBootstrap({ ...bootstrap, settings: next })
      }}
    />
  )
}
