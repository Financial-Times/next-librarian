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
const regices = require('@quarterto/regices')

const slackBot = new Slack({token: process.env.SLACK_BOT_TOKEN})
const slackUser = new Slack({token: process.env.SLACK_USER_TOKEN})

let Answers

async function setup() {
	const client = await MongoClient.connect(process.env.MONGO_URL)
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
		/^<?https:\/\/\w+.slack.com\/archives\/([GC][\dA-Z]+)\/p(\d{10})(\d{6})>?$/
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
			ts: context.parent || context.message,
			channel: context.channel
		}),
		{text}
	)}

	const permalink = parseSlackPermalink(spec)
	if(permalink) return {type: 'message', data: await getMessage(permalink)}

	if(spec === 'this') return {type: 'message', data: await getMessage({
		ts: context.parent,
		channel: context.channel
	})} //TODO get previous message

	throw new Error(`couldn't parse`)
}

const postAnswers = (answers, {event, boneless = false} = {}) => slackBot.chat.postMessage({
	channel: event.event.channel,
	thread_ts: event.event.thread_ts || event.event.ts,
	as_user: true,
	icon_emoji: 'books',
	text: !answers.length ? `sorry, i couldn't find anything relevant. maybe somebody else knows?` : '',
	attachments: flatMap(answers, answer => [
		{
			fallback: answer.question.data.text,
			text: answer.question.data.text,
			color: '#00994d',
			ts: answer.question.data.ts
		},
		{
			fallback: answer.answer.data.text,
			text: answer.answer.data.text,
			color: '#0f5499',
			ts: answer.answer.data.ts
		}
	])
})

module.exports = route({
	'/': () => `
	<!doctype html>
	<form action="/answers" method="post">
		<label>
			question
			<input name="question">
		</label>
		<label>
			answer
			<input name="answer">
		</label>
		<label>
			date
			<input name="date" type="date">
		</label>
		<input type="submit">
	</form>
	<form action="/ask" method="get">
		<input type="search" name="q">
		<input type="submit">
	</form>
	`,

	'/answers': get(() => Answers.find({}).toArray()),

	'/answers': post(async (req, res) => {
		const data = await form(req)
		data.date = new Date(data.date)

		const {insertedIds: {0: id}} = await Answers.insert(data)
		res.setHeader('location', `/answers/${id}`)
		return send(res, 302)
	}),

	'/answers/:id' (req, res, {id}) {
		return Answers.findOne({_id: new ObjectID(id)})
	},

	'/ask' (req, res) {
		const {query} = url.parse(req.url, true)

		return 
	},

	'/slack-permalink' (req) {
		const {query} = url.parse(req.url, true)
		const deets = parseSlackPermalink(query.url)
		return slackUser.conversations.replies(deets)
	},

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
						const parser = regices({
							async '^<@U[\\dA-Z]+>(.*)\\?' (_, query) {
								if(!query) {
									const parentMessage = await getMessage({
										channel: event.event.channel,
										ts: event.event.thread_ts
									})

									query = parentMessage.text
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

								const sorted = orderBy(answers, answer => {
									const recency = 1 + new Date() - new Date(answer.answer.data.date)
									return answer.score / recency
								}, 'desc')

								await postAnswers(sorted, {event})
								return send(res, 200)
							},

							async '^<@U[\\dA-Z]+>(.+) (?:is (?:the|an) answer to|answers) (.+)$' (_, answerSpec, questionSpec) {
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

							async '^<@U[\\dA-Z]+> forget everything you(\'|’)ve ever learnt. yes i(\'|’)m sure' () {
								await Answers.remove({})

								await slackBot.chat.postMessage({
									channel: event.event.channel,
									thread_ts: event.event.thread_ts || event.event.ts,
									as_user: true,
									icon_emoji: 'books',
									text: 'wait who are you again'
								})

								return send(res, 200)
							}
						})

						try {
							const result = parser(event.event.text)
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
