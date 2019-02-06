const method = method => handler => (req, ...args) => req.method === method ? handler(req, ...args) : false
const get = method('GET')
const post = method('POST')

const route = require('boulevard')
const {MongoClient, ObjectID} = require('mongodb')
const {json, send, text} = require('micro')
const form = require('urlencoded-body-parser')
const url = require('url')

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

		return Answers.find({
			$text: {$search: query.q}
		}, {
			fields: {
				score: { $meta: "textScore" }
			},
			sort: {
				date: -1
			}
		}).toArray()
	},
})