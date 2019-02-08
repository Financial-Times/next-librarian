const method = method => handler => (req, ...args) => req.method === method ? handler(req, ...args) : false
const get = method('GET')
const post = method('POST')

const route = require('boulevard')
const {MongoClient, ObjectID} = require('mongodb')
const {json, send, text} = require('micro')
const form = require('urlencoded-body-parser')
const url = require('url')
const Slack = require('slack')
const orderBy = require('lodash.orderby')
const flatMap = require('lodash.flatmap')
const groupBy = require('lodash.groupby')
const regices = require('@quarterto/regices')

const slackBot = new Slack({token: process.env.SLACK_BOT_TOKEN})
const slackUser = new Slack({token: process.env.SLACK_USER_TOKEN})

let Answers

async function setup() {
	const client = await MongoClient.connect(process.env.MONGODB_URI)
	const db = client.db()
	
	Answers = db.collection('answers')
	Answers.ensureIndex({
		'question.data.text': 'text'
	})
}

setup().catch(error => {
	console.error(error.stack)
	process.exit(1)
})

const parseSlackPermalink = permalink => {
	const [match, channel, ts1, ts2] = permalink.match(
		/^<?https:\/\/\w+.slack.com\/archives\/([GC][\dA-Z]+)\/p(\d{10})(\d{6})(?:\??.*)?>?$/
	) || [false]

	if(!match) {
		return false
	}

	return {
		channel,
		ts: `${ts1}.${ts2}`
	}
}

const getMessage = query => slackUser.conversations.replies(query).then(
	({messages}) => Object.assign(
		{},
		query,
		messages[0]
	)
)

const parseSpec = async (spec, context) => {
	spec = spec.trim()

	const [isText, text] = spec.match(/^(?:"|“)(.+)(?:"|”)$/) || [false]
	if(isText) return {type: 'text', data: Object.assign(
		await getMessage({
			ts: context.message,
			channel: context.channel
		}),
		{text}
	)}

	const permalink = parseSlackPermalink(spec)
	if(permalink) return {type: 'message', data: await getMessage(permalink)}

	if(spec === 'this') return {type: 'message', data: await getMessage({
		ts: context.parent,
		channel: context.channel
	})} //TODO get previous message?

	throw new Error(`couldn't parse`)
}

const answerAuthorInfo = async answer => {
	const {user} = await slackBot.users.info({
		user: answer.data.user
	})

	const {permalink} = await slackBot.chat.getPermalink({
		channel: answer.data.channel,
		message_ts: answer.data.ts,
	})

	const {channel} = await slackBot.conversations.info({
		channel: answer.data.channel
	})

	return {
		footer: `${user.real_name} <${permalink}|in #${channel.name}>`,
		footer_icon: user.profile.image_32,
	}
}

const answerAttachment = async (answer, {boneless, color, extra}) => Object.assign({
	fallback: answer.data.text,
	text: answer.data.text,
	color,
}, extra, boneless ? {} : Object.assign({
	ts: answer.data.ts,
}, await answerAuthorInfo(answer)))

const parseColour = colour => {
	const [hash, r1, r2, g1, g2, b1, b2] = colour
	return [
		[r1, r2],
		[g1, g2],
		[b1, b2],
	].map(
		([c1, c2]) => 0x10 * parseInt(c1, 16) + parseInt(c2, 16)
	)
}
const formatColour = rgb => '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('')
const mixColour = (from, to) => amount => formatColour(
	[from, to].map(parseColour).reduce((from, to) => from.map((c, i) => Math.round(c + amount * (to[i] - c))))
)

const questionColour = mixColour('#00994d', '#ffffff')
const answerColour = mixColour('#0f5499', '#ffffff')

const postAnswers = async (answers, {event, boneless = false, debug = false} = {}) => {
	const maxScore = Math.max(...answers.map(answer => answer.sortScore))

	const attachments = await Promise.all(
		answers.reduce((attachments, answer, i) => {
			const scoreQuotient = boneless ? 0 : Math.sqrt((maxScore - answer.sortScore) / maxScore)

			const answerAttachments = [
				answerAttachment(answer.answer, {color: answerColour(scoreQuotient), boneless, extra: {
					author_name: debug ? `score: ${answer.sortScore}, returned: ${answer.returned}` : null,
				}})
			]

			if(boneless) answerAttachments.push({
				text: '',
				callback_id: answer._id,
				actions: boneless ? [{
					"name": "delet this",
					"text": "Undo",
					"style": "danger",
					"type": "button",
				}] : [],
			})

			if(
				i === 0
				|| (answer.question.type === 'message' &&
					answer.question.data.ts !== answers[i - 1].question.data.ts
				) 
				|| (answer.question.type === 'text' &&
					answer.question.data.text !== answers[i - 1].question.data.text
				)
			) {
				answerAttachments.unshift(
					answerAttachment(answer.question, {color: questionColour(scoreQuotient), boneless})
				)
			}

			return attachments.concat(answerAttachments)
		},
		[]
	))

	return slackBot.chat.postMessage({
		channel: event.event.channel,
		thread_ts: event.event.thread_ts || event.event.ts,
		as_user: true,
		text: !answers.length ? `sorry, i couldn't find anything relevant. maybe somebody else knows?` : '',
		attachments
	})
}

module.exports = route({
	'/slack-action': post(async (req, res) => {
		const {payload} = await form(req)
		const data = JSON.parse(payload)

		if(data.token !== process.env.SLACK_VERIFICATION_TOKEN) {
			return send(res, 401)
		}

		for(const action of data.actions) switch(action.name) {
			case 'delet this': {
				await Answers.remove({_id: new ObjectID(data.callback_id)})
				await slackBot.chat.delete({
					ts: data.message_ts,
					channel: data.channel.id,
				})
			}
		}

		return send(res, 200)
	}),

	async '/slack-event' (req, res) {
		const event = await json(req)

		if(event.token !== process.env.SLACK_VERIFICATION_TOKEN) {
			return send(res, 401)
		}

		switch(event.type) {
			case 'url_verification': {
				return event.challenge
			}

			case 'event_callback': {
				switch(event.event.type) {
					case 'app_mention': {
						const removeMention = text => text.replace(new RegExp(`\\s*<@${event.authed_users[0]}>\\s*`, 'g'), '').trim()
						const eventTextWithoutMention = removeMention(event.event.text)

						const parser = regices({
							async '^(.+) (?:is (?:the|an) answer to|answers) (.+)$' (_, answerSpec, questionSpec) {
								const context = {
									parent: event.event.thread_ts,
									message: event.event.ts,
									channel: event.event.channel
								}

								const [answer, question] = await Promise.all([
									parseSpec(answerSpec, context),
									parseSpec(questionSpec, context)
								])

								const answerData = { answer, question }
								await Answers.insert(answerData)

								await postAnswers([answerData], {event, boneless: true})

								return send(res, 200)
							},

							async '.*' (query) {
								let debug = false
								if(query.includes('DEBUG')) {
									query = query.replace('DEBUG', '').trim()
									debug = true
								}

								query = query.replace(/\?$/g, '')

								if(!query) {
									const parentMessage = await getMessage({
										channel: event.event.channel,
										ts: event.event.thread_ts
									})

									query = removeMention(parentMessage.text)
								}

								const answers = await Answers.find({
									$and: [
										{$text: {$search: query}},
										{$or: [
											{'answer.type': 'text'},
											{'answer.data.channel': event.event.channel},
											{'answer.data.channel': {$regex: '^C'}}, // starts with C: is public channel
										]},
										{$or: [
											{'question.type': 'text'},
											{'question.data.channel': event.event.channel},
											{'question.data.channel': {$regex: '^C'}},
										]},
									]
								}, {
									fields: {
										score: { $meta: "textScore" }
									}
								}).limit(10).toArray()

								// increment the number of times these answers has been returned but don't wait for it
								Answers.updateMany(
									{_id: {$in: answers.map(({_id}) => new ObjectID(_id))}},
									{$inc: {returned: 1}},
								)

								const sorted = orderBy(answers, answer => {
									const recency = Math.sqrt(1 + Date.now() / 1000 - parseFloat(answer.answer.data.ts))
									return answer.sortScore = answer.score / recency
								}, 'desc')

								await postAnswers(sorted, {event, debug})
								return send(res, 200)
							}
						})

						try {
							const result = parser(eventTextWithoutMention)
							if(result) {
								return await result
							}

							await slackBot.chat.postMessage({
								channel: event.event.channel,
								text: `hmmmmm i didn't understand "${event.event.text}"`,
								thread_ts: event.event.thread_ts || event.event.ts,
								as_user: true,
								icon_emoji: 'books'
							})

							return send(res, 200)
						} catch(error) {
							console.error(error.stack)

							await slackBot.chat.postMessage({
								channel: event.event.channel,
								text: `i don't know about that one chief`,
								attachments: [{
									color: '#990f3d',
									text: '```' + error.message + '```'
								}],
								thread_ts: event.event.thread_ts || event.event.ts,
								as_user: true,
								icon_emoji: 'books'
							})

							return send(res, 200)
						}
					}
				}
			}
		}

		return send(res, 400)
	}
})
