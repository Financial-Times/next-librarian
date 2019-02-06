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

const slackBot = new Slack({token: process.env.SLACK_BOT_TOKEN})
const slackUser = new Slack({token: process.env.SLACK_USER_TOKEN})

let Answers

async function setup() {
	const client = await MongoClient.connect(process.env.MONGO_URL)
	const db = client.db()
	
	Answers = db.collection('answers')
	Answers.ensureIndex({
		question: 'text'
	})
}

setup().catch(error => {
	console.error(error.stack)
	process.exit(1)
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
						const isQuestion = event.event.text.endsWith('?')

						if(isQuestion) {
							let [, query] = event.event.text.match(/^<@U[\dA-Z]+>(.*)?$/)
							
							if(!query) {
								const {messages: [parentMessage]} = await slackUser.conversations.replies({
									channel: event.event.channel,
									ts: event.event.thread_ts
								})

								query = parentMessage.text
							}

							const answers = await Answers.find({
								$text: {$search: query}
							}, {
								fields: {
									score: { $meta: "textScore" }
								}
							}).limit(10).toArray()

							const sorted = orderBy(answers, answer => {
								const recency = 1 + new Date() - new Date(answer.date)
								return answer.score / recency
							}, 'desc')

							await slackBot.chat.postMessage({
								channel: event.event.channel,
								thread_ts: event.event.thread_ts || event.event.ts,
								as_user: true,
								icon_emoji: 'books',
								text: !answers.length ? `sorry, i couldn't find anything relevant. maybe somebody else knows?` : '',
								attachments: flatMap(sorted, answer => [
									{
										fallback: answer.question,
										text: answer.question,
										color: '#00994d',
										ts: new Date(answer.date).getTime() / 1000
									},
									{
										fallback: answer.answer,
										text: answer.answer,
										color: '#0f5499',
										ts: new Date(answer.date).getTime() / 1000
									}
								])
							})
						} else {
							await slackBot.chat.postMessage({
								channel: event.event.channel,
								text: 'hmmmm',
								thread_ts: event.event.thread_ts || event.event.ts,
								as_user: true,
								icon_emoji: 'books'
							})
						}

						return ''
					}
				}
			}
		}

		return send(res, 400)
	}
})
