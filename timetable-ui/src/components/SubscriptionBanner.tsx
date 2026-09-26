import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'

/** Days left in a trial below which the app starts saying so. */
const TRIAL_NOTICE_DAYS = 14

/**
 * SAMS 13.3 — a line above every page while a trial runs out or a lapsed
 * subscription is in its grace or read-only days, linking those who can
 * act to Settings → Subscription.
 */
export function SubscriptionBanner() {
  const { t } = useI18n()
  const { subscription, plan, trialEndsOn, can } = useAuth()
  if (!subscription) return null
  const link = can('settings.read') ? (
    <Link to="/settings/subscription" className="subscription-banner__link">
      {t(plan === 'trial' ? 'banner.choose' : 'banner.renew')}
    </Link>
  ) : null

  if (subscription.state === 'grace' && subscription.graceEnds) {
    return (
      <div className="subscription-banner subscription-banner--warn" role="status">
        {t('banner.grace', { date: subscription.graceEnds })} {link}
      </div>
    )
  }
  if (subscription.state === 'readOnly' && subscription.readOnlyUntil) {
    return (
      <div className="subscription-banner subscription-banner--warn" role="status">
        {t('banner.readOnly', { date: subscription.readOnlyUntil })} {link}
      </div>
    )
  }
  if (plan === 'trial' && trialEndsOn && subscription.state === 'active') {
    const days = Math.max(0, Math.ceil((Date.parse(`${trialEndsOn}T23:59:59Z`) - Date.now()) / 86_400_000))
    if (days > TRIAL_NOTICE_DAYS) return null
    return (
      <div className="subscription-banner" role="status">
        {t('banner.trial', { days: String(days) })} {link}
      </div>
    )
  }
  return null
}
