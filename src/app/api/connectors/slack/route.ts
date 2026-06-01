import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json() as { channel?: unknown; botToken?: unknown }
    const { channel, botToken } = body

    if (!channel) {
      return NextResponse.json({ error: 'Channel required' }, { status: 400 })
    }

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('project_id')
      .eq('id', user.id)
      .single()

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, string> = { slack_channel: channel as string }
    if (typeof botToken === 'string' && botToken.startsWith('xoxb-')) {
      updateData.slack_bot_token = botToken
    }

    const { error: updateError } = await supabase
      .from('projects')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(updateData as any)
      .eq('id', userData.project_id)

    if (updateError) {
      console.error('Update error:', updateError)
      return NextResponse.json({ error: 'Failed to save', details: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Slack connector error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
